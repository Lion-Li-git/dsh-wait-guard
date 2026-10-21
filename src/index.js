// dsh-wait-guard — bounded waiting for DeepSeek Harness.
//
// Why this exists (measured, session b3a09167, 4 days):
//   * 59 job_output waits with wait: true, 5447 s of blocked turns (~91 min);
//     52 of them used timeout_ms: 115000 — the model treated the 120 s cap as
//     a budget to sit just under, and looped.
//   * run_code's own 120 s program deadline killed nested foreground commands,
//     and "execution deadline reached (120000ms)" read like a limit on the task.
//
// What it does, all through the host-plane tool pipeline:
//   1. job_output with wait: true is a bounded probe: <= 20 s per call, only
//      while the job is younger than 2 minutes, at most 40 s in total per job.
//   2. A foreground pwsh nested in run_code may not declare a timeout above
//      the program deadline — that command would be cut off mid-flight.
//   3. run_code taking longer than 45 s, or dying on its deadline, gets a hint
//      that says which budget that was and that long work belongs in the
//      background.
//
// Everything fails open: unknown tools, missing services, missing jobs.
//
// Config (all optional, milliseconds):
//   perCallMaxMs, youngMs, totalBudgetMs, defaultWaitMs,
//   slowProgramMs, programDeadlineMs

const name = 'dsh-wait-guard';
const inject = ['tools'];

const DEFAULTS = Object.freeze({
	perCallMaxMs: 20000,
	youngMs: 120000,
	totalBudgetMs: 40000,
	defaultWaitMs: 30000,
	slowProgramMs: 45000,
	programDeadlineMs: 120000
});

const DEADLINE_HINT = '[wait-guard] execution deadline reached is run_code own program budget, not a limit on the task or on the command. The nested call was aborted at that deadline; whatever the command already did stays done. For anything that may outlive the program, do not nest it: call pwsh with run_in_background: true, then end the turn - the completion notice opens the next one.';

function slowHint(sec, perCallMaxMs) {
	return '[wait-guard] this program held the turn for ' + sec + 's of foreground work. Anything that long belongs in the background: start it with pwsh({ run_in_background: true }), then end the turn - the completion notice opens the next one. Foreground seconds are latency the user pays for, and the program deadline will kill anything past the default budget.';
}

function apply(ctx, config) {
	const cfg = { ...DEFAULTS, ...(config || {}) };
	const spent = new Map();
	const inflight = new WeakMap();
	const started = new WeakMap();

	ctx.on('tools/pre-execute', (exec, next) => {
		try {
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
