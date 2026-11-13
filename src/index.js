// dsh-wait-guard — bounded waiting and no-progress polling breaker for DeepSeek Harness.
//
// Why this exists (measured):
//   * session b3a09167, 4 days: 59 job_output waits with wait: true, 5447 s of
//     blocked turns (~91 min); 52 of them used timeout_ms: 115000 — the model
//     treated the 120 s cap as a budget to sit just under, and looped.
//   * session 04e0a3ef (Epirus-Web), 11-10/11-11: turn 18 asked "why is it taking
//     50 min"; the model had the answer after 2 steps, then wrote "Answer now."
//     and emitted a run_code call anyway — 47 times in 2.3 min (log tail /
//     process check, same output) until the user pressed stop. turn 22 did 13
//     tool-only steps after "what are you doing".
//   * 7 run_code failures "Expected ',', got 'ident'" were all an unescaped
//     backtick inside a JS template literal (PowerShell `t / `n, or Markdown
//     backticks inside compress summaries). The error had no location.
//
// What it does, all through the host-plane tool pipeline:
//   1. job_output with wait: true is a bounded probe: <= 20 s per call, only
//      while the job is younger than 2 minutes, at most 40 s in total per job.
//   2. A foreground pwsh nested in run_code may not declare a timeout above
//      the program deadline — that command would be cut off mid-flight.
//   3. run_code taking longer than 45 s, or dying on its deadline, gets a hint
//      that says which budget that was and that long work belongs in the
//      background.
//   4. Four consecutive status probes (run_code/pwsh that only read job status,
//      logs, processes or the clock; or a direct no-wait job_output) inside
//      120 s are denied: answer from the state already known and end the turn.
//      A work call resets the counter, so normal long tasks are untouched.
//   5. Three consecutive no-op run_code calls (a constant console.log, an empty
//      program, or description "No-op") are denied: write the answer in text.
//      A work call resets both counters; a status probe does not reset the
//      no-op counter, so alternating the two cannot evade either one.
//   6. A JS parse error gets a hint naming unescaped backticks.
//
// Everything fails open: unknown tools, missing services, missing jobs.
//
// Config (all optional, milliseconds):
//   perCallMaxMs, youngMs, totalBudgetMs, defaultWaitMs,
//   slowProgramMs, programDeadlineMs, probeLimit, probeWindowMs, noopLimit

const name = 'dsh-wait-guard';
const inject = ['tools'];

const DEFAULTS = Object.freeze({
	perCallMaxMs: 20000,
	youngMs: 120000,
	totalBudgetMs: 40000,
	defaultWaitMs: 30000,
	slowProgramMs: 45000,
	programDeadlineMs: 120000,
	probeLimit: 4,
	probeWindowMs: 120000,
	noopLimit: 3
});

const DEADLINE_HINT = '[wait-guard] execution deadline reached is run_code own program budget, not a limit on the task or on the command. The nested call was aborted at that deadline; whatever the command already did stays done. For anything that may outlive the program, do not nest it: call pwsh with run_in_background: true, then end the turn - the completion notice opens the next one.';

function slowHint(sec, perCallMaxMs) {
	return '[wait-guard] this program held the turn for ' + sec + 's of foreground work. Anything that long belongs in the background: start it with pwsh({ run_in_background: true }), then end the turn - the completion notice opens the next one. Foreground seconds are latency the user pays for, and the program deadline will kill anything past the default budget.';
}

// A program that only reads state: job status, logs, process list, clock.
const STATUS_RE = /\bjob_output\s*\(|Get-CimInstance|Get-Date\b|Get-Content\b[^\n]*(\.log|-Tail)|Get-ChildItem\b[^\n]*(log|eps)|Select-String\b[^\n]*\.log|Get-Process\b|Wait-Process\b|Test-Path\b[^\n]*log/i;

// A program that changes something: never counted as a status probe.
const WORK_RE = /writeFileSync|writeFile\s*\(|appendFileSync|Set-Content|Add-Content|Out-File|Start-Process|git\s+(add|commit|checkout|push|reset|merge)|npm\s+(install|run)|node\s+tools\/|tools\.(write|edit)\s*\(|renameSync|copyFileSync|unlinkSync|mkdirSync/i;

const PARSE_RE = /Expected ',', got 'ident'|Unexpected token|Invalid or unexpected token/i;

// A run_code that does nothing: description "No-op", an empty program, or a
// single constant console.log. This is the shape of the 11-13 loop (t74/t75).
const NOOP_DESC_RE = /^\s*no[\s-]?op\s*$/i;
const CONST_LOG_RE = /^console\.log\(\s*(["'`])(.*)\1\s*\)\s*;?$/;

function parseHint(code) {
	const ticks = typeof code === 'string' ? (code.match(/`/g) || []).length : 0;
	let hint =
		'[loop-guard] This is a JavaScript parse error in the program text, not a task failure. ' +
		'The most common cause on this deployment is an unescaped backtick inside a template literal: ' +
		'PowerShell escapes like `t / `n, and Markdown backticks in a compress summary, close the JS template early. ' +
		'Fix it by avoiding backticks in the program: use [char]9 for a tab, [Environment]::NewLine for a newline, ' +
		'write the PowerShell to a temporary .ps1 and run that, or escape every backtick as \\` inside the template.';
	if (ticks >= 2) hint += ' Your program contains ' + ticks + ' backtick characters; check each one inside a template literal.';
	return hint;
}

function apply(ctx, config) {
	const cfg = { ...DEFAULTS, ...(config || {}) };
	const spent = new Map();
	const inflight = new WeakMap();
	const started = new WeakMap();
	const probes = new Map();
	const noops = new Map();

	const argsOf = (exec) => {
		const a = exec && exec.arguments;
		if (!a) return {};
		if (typeof a === 'string') {
			try { return JSON.parse(a); } catch { return {}; }
		}
		return a;
	};
	const probeKey = (exec) => (exec && exec.agent && exec.agent.id) || 'root';
	const probeAt = (exec) => {
		const key = probeKey(exec);
		let st = probes.get(key);
		if (!st) {
			st = { count: 0, lastAt: 0, denied: 0 };
			probes.set(key, st);
		}
		return st;
	};
	const probeDenyReason = (st) =>
		'[loop-guard] status probe #' + st.count + ' with no new information (job/log/process only). ' +
		'Do not keep polling: answer the user now from the latest state you already have, say the job is still running, and end the turn. ' +
		'If you must wait, end the turn - the completion notice opens the next one. Do not issue another status command this turn. ' +
		( st.denied >= 2
			? 'This is denial #' + st.denied + ': every further status probe this turn will be denied. Stop and answer in text.'
			: '不要继续查，直接用已知状态回答并结束本轮。' );
	const probeBump = (exec, isProbe) => {
		const now = Date.now();
		const st = probeAt(exec);
		if (now - st.lastAt > cfg.probeWindowMs) {
			st.count = 0;
			st.denied = 0;
		}
		st.lastAt = now;
		if (!isProbe) {
			st.count = 0;
			st.denied = 0;
			return null;
		}
		st.count += 1;
		if (st.count < cfg.probeLimit) return null;
		st.denied += 1;
		return { kind: 'deny', reason: probeDenyReason(st) };
	};
	const noopAt = (exec) => {
		const key = probeKey(exec);
		let st = noops.get(key);
		if (!st) {
			st = { count: 0, lastAt: 0, denied: 0 };
			noops.set(key, st);
		}
		return st;
	};
	const noopDenyReason = (st) =>
		'[loop-guard] no-op run_code #' + st.count + ': this program only prints a constant and does nothing. ' +
		'Do not call run_code again; write the final answer in the assistant text now. ' +
		( st.denied >= 2
			? 'This is denial #' + st.denied + ': every further no-op call this turn will be denied.'
			: '别再发空调用，直接输出文本回答。' );
	const noopBump = (exec, isNoop) => {
		const now = Date.now();
		const st = noopAt(exec);
		if (now - st.lastAt > cfg.probeWindowMs) {
			st.count = 0;
			st.denied = 0;
		}
		st.lastAt = now;
		if (!isNoop) {
			st.count = 0;
			st.denied = 0;
			return null;
		}
		st.count += 1;
		if (st.count < cfg.noopLimit) return null;
		st.denied += 1;
		return { kind: 'deny', reason: noopDenyReason(st) };
	};
	const isNoop = (a) => {
		const desc = typeof a.description === 'string' ? a.description : '';
		if (NOOP_DESC_RE.test(desc)) return true;
		const code = typeof a.code === 'string' ? a.code : '';
		const compact = code.replace(/\s+/g, ' ').trim();
		if (!compact) return true;
		if (/^return;?$/i.test(compact)) return true;
		if (/^\/\//.test(compact)) return true;
		return CONST_LOG_RE.test(compact);
	};
	// Returns a deny for a no-progress call, otherwise null.
	const probeCheck = (exec) => {
		const a = argsOf(exec);
		if (exec.name === 'run_code') {
			const code = typeof a.code === 'string' ? a.code : '';
			if (!code || isNoop(a)) return noopBump(exec, true);
			const probe = !WORK_RE.test(code) && STATUS_RE.test(code);
			if (!probe) noopBump(exec, false); // real work resets the no-op count
			return probeBump(exec, probe);
		}
		const direct = exec.parent === undefined || exec.parent === null;
		if (exec.name === 'job_output' && direct) {
			if (a.wait === true) return null; // wait-guard owns bounded waits
			return probeBump(exec, typeof a.job_id === 'string' && a.job_id.length > 0);
		}
		if (exec.name === 'pwsh' && direct) {
			if (a.run_in_background === true) return null;
			const cmd = typeof a.command === 'string' ? a.command : '';
			if (!cmd) return null;
			const probe = !WORK_RE.test(cmd) && STATUS_RE.test(cmd);
			if (!probe) noopBump(exec, false);
			return probeBump(exec, probe);
		}
		if (exec.name === 'write' || exec.name === 'edit' || exec.name === 'apply_patch') {
			probeBump(exec, false);
			noopBump(exec, false);
		}
		return null;
	};

	ctx.on('tools/pre-execute', (exec, next) => {
		try {
			if (exec) {
				const denied = probeCheck(exec);
				if (denied) return denied;
			}
			if (exec.name === 'run_code') {
				started.set(exec, Date.now());
				return next();
			}
			if (exec.name === 'pwsh' && exec.parent !== undefined) {
				const a = exec.arguments || {};
				if (a.run_in_background === true) return next();
				const t = typeof a.timeoutMs === 'number' ? a.timeoutMs : null;
				if (t === null || t <= cfg.programDeadlineMs) return next();
				return {
					kind: 'deny',
					reason: '[wait-guard] this foreground command asks for ' + t + 'ms inside run_code, whose own deadline defaults to ' + cfg.programDeadlineMs + 'ms. The program dies at that deadline and the command is aborted with it. Start it as a background job (run_in_background: true) and end the turn; a command that really finishes in seconds does not need a timeout above ' + cfg.programDeadlineMs + 'ms.'
				};
			}
			if (exec.name !== 'job_output') return next();
			const a = exec.arguments || {};
			if (a.wait !== true) return next();
			const id = a.job_id;
			if (typeof id !== 'string' || id.length === 0) return next();
			const jobs = ctx.get('jobs');
			if (!jobs) return next();
			let job;
			try {
				job = jobs.get(id, exec.agent && exec.agent.id);
			} catch {
				return next();
			}
			if (!job || job.status !== 'running') return next();
			const timeout = typeof a.timeout_ms === 'number' ? a.timeout_ms : cfg.defaultWaitMs;
			if (timeout > cfg.perCallMaxMs) {
				return {
					kind: 'deny',
					reason: '[wait-guard] job_output wait: true accepts at most ' + cfg.perCallMaxMs + 'ms; got ' + timeout + 'ms. Pass timeout_ms <= ' + cfg.perCallMaxMs + ', or end the turn and let the completion notice open the next one.'
				};
			}
			const age = Date.now() - job.startedAt;
			if (age > cfg.youngMs) {
				return {
					kind: 'deny',
					reason: '[wait-guard] job ' + id + ' has been running ' + Math.round(age / 1000) + 's: that is a long job. Do not wait on it. End the turn; its completion notice opens a new turn by itself.'
				};
			}
			const used = spent.get(id) || 0;
			if (used >= cfg.totalBudgetMs) {
				return {
					kind: 'deny',
					reason: '[wait-guard] you already spent ' + Math.round(used / 1000) + 's waiting on ' + id + ' (budget ' + Math.round(cfg.totalBudgetMs / 1000) + 's). Stop reading it; end the turn.'
				};
			}
			inflight.set(exec, { id, t0: Date.now() });
			return next();
		} catch {
			return next();
		}
	});

	ctx.on('tools/post-execute', (exec, result, next) => {
		try {
			if (exec.name === 'job_output') {
				const rec = inflight.get(exec);
				if (rec) {
					inflight.delete(exec);
					spent.set(rec.id, (spent.get(rec.id) || 0) + (Date.now() - rec.t0));
				}
				return next();
			}
			if (exec.name !== 'run_code') return next();
			const began = started.get(exec);
			if (began !== undefined) started.delete(exec);
			const held = began === undefined ? 0 : Date.now() - began;
			if (result && result.isError === true) {
				const blocks = Array.isArray(result.content) ? result.content : [];
				const text = blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
				if (PARSE_RE.test(text) && text.indexOf('[loop-guard]') < 0) {
					return { kind: 'accept', content: [...blocks, { type: 'text', text: parseHint(argsOf(exec).code) }] };
				}
				if (!/execution deadline reached/.test(text)) return next();
				return { kind: 'accept', content: [...blocks, { type: 'text', text: DEADLINE_HINT }] };
			}
			if (held > cfg.slowProgramMs && result && Array.isArray(result.content)) {
				return { kind: 'accept', content: [...result.content, { type: 'text', text: slowHint(Math.round(held / 1000)) }] };
			}
			return next();
		} catch {
			return next();
		}
	});
}

export { apply, inject, name };
