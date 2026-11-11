import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.js';

const jobs = { get: () => ({ status: 'running', startedAt: Date.now() }) };

function makeCtx(config) {
	const handlers = new Map();
	const ctx = {
		on: (name, fn) => {
			if (!handlers.has(name)) handlers.set(name, []);
			handlers.get(name).push(fn);
		},
		get: (name) => (name === 'jobs' ? jobs : undefined)
	};
	apply(ctx, config);
	const fire = (name, ...args) => {
		const list = handlers.get(name) || [];
		return list.length === 0 ? { kind: 'next' } : list[0](...args, () => ({ kind: 'next' }));
	};
	return {
		pre: (exec) => fire('tools/pre-execute', exec),
		post: (exec, result) => fire('tools/post-execute', exec, result)
	};
}

const agent = { id: 'agent-1' };
const run = (code) => ({ name: 'run_code', agent, arguments: { code, description: 'test' } });
const jobOut = (job_id, extra = {}) => ({ name: 'job_output', agent, arguments: { job_id, ...extra } });
const pwsh = (command, extra = {}) => ({ name: 'pwsh', agent, arguments: { command, ...extra } });

const STATUS = `const out = await tools.job_output({ job_id: "pwsh-abc" });
console.log(out.job.status);`;
const LOG = `const r = await tools.pwsh({
  description: "Check logs",
  command: String.raw\`
Get-Date -Format "HH:mm:ss"
Get-Content D:\\code\\x\\scratch\\run.log -Tail 20
\`
});
console.log(r.stdout.text);`;
const WORK = `const r = await tools.pwsh({
  description: "Commit",
  command: String.raw\`
git -C D:\\code\\x add -A
git -C D:\\code\\x commit -m "fix"
\`
});`;

test('four consecutive status probes are denied, the fifth escalates', () => {
	const c = makeCtx();
	assert.equal(c.pre(run(STATUS)).kind, 'next');
	assert.equal(c.pre(run(LOG)).kind, 'next');
	assert.equal(c.pre(run(STATUS)).kind, 'next');
	const fourth = c.pre(run(LOG));
	assert.equal(fourth.kind, 'deny');
	assert.match(fourth.reason, /answer the user now/);
	const fifth = c.pre(run(STATUS));
	assert.equal(fifth.kind, 'deny');
	assert.match(fifth.reason, /denial #2/);
});

test('a work call resets the probe counter', () => {
	const c = makeCtx();
	c.pre(run(STATUS));
	c.pre(run(STATUS));
	c.pre(run(STATUS));
	assert.equal(c.pre(run(WORK)).kind, 'next');
	assert.equal(c.pre(run(STATUS)).kind, 'next');
});

test('a plain read is not a status probe', () => {
	const c = makeCtx();
	const r = c.pre(run(`const r = await tools.read({ file_path: "D:\\\\x\\\\README.md" });
console.log(r.lines.length);`));
	assert.equal(r.kind, 'next');
});

test('direct no-wait job_output counts; wait:true is left to the wait rules', () => {
	const c = makeCtx();
	assert.equal(c.pre(jobOut('j1')).kind, 'next');
	assert.equal(c.pre(jobOut('j1')).kind, 'next');
	assert.equal(c.pre(jobOut('j1')).kind, 'next');
	assert.equal(c.pre(jobOut('j1')).kind, 'deny');
	const c2 = makeCtx();
	assert.equal(c2.pre(jobOut('j2', { wait: true, timeout_ms: 10000 })).kind, 'next');
	const denied = c2.pre(jobOut('j2', { wait: true, timeout_ms: 30000 }));
	assert.equal(denied.kind, 'deny');
	assert.match(denied.reason, /accepts at most/);
});

test('direct pwsh status commands count; a work command resets', () => {
	const c = makeCtx();
	assert.equal(c.pre(pwsh('Get-Date -Format HH:mm:ss')).kind, 'next');
	assert.equal(c.pre(pwsh('Get-CimInstance Win32_Process')).kind, 'next');
	assert.equal(c.pre(pwsh('Get-Content run.log -Tail 20')).kind, 'next');
	assert.equal(c.pre(pwsh('Get-Date -Format HH:mm:ss')).kind, 'deny');
	const c2 = makeCtx();
	c2.pre(pwsh('Get-Date'));
	c2.pre(pwsh('Get-Date'));
	c2.pre(pwsh('Get-Date'));
	assert.equal(c2.pre(pwsh('git add -A')).kind, 'next');
	assert.equal(c2.pre(pwsh('Get-Date')).kind, 'next');
});

test('nested pwsh timeout above the program deadline is still denied', () => {
	const c = makeCtx();
	const denied = c.pre({ name: 'pwsh', agent, parent: {}, arguments: { command: 'x', timeoutMs: 600000 } });
	assert.equal(denied.kind, 'deny');
	assert.match(denied.reason, /foreground command asks for/);
});

test('a JS parse error gets the backtick hint exactly once', () => {
	const c = makeCtx();
	const code = `const r = await tools.pwsh({
  command: String.raw\`
$rows = Import-Csv x.tsv -Delimiter "\`t"
\`
});`;
	const result = { isError: true, content: [{ type: 'text', text: "Error: code run failed (exception): Expected ',', got 'ident'" }] };
	const out = c.post(run(code), result);
	assert.equal(out.kind, 'accept');
	const text = out.content.map((b) => b.text || '').join('');
	assert.match(text, /backtick/);
	assert.match(text, /contains \d+ backtick characters/);
	const again = c.post(run(code), { isError: true, content: out.content });
	assert.equal(again.kind, 'next');
});

test('the execution-deadline hint still works', () => {
	const c = makeCtx();
	const out = c.post(run('console.log(1)'), {
		isError: true,
		content: [{ type: 'text', text: 'Error: code run failed (exception): execution deadline reached' }]
	});
	assert.equal(out.kind, 'accept');
	const text = out.content.map((b) => b.text || '').join('');
	assert.match(text, /\[wait-guard\] execution deadline reached/);
});

test('other errors are untouched', () => {
	const c = makeCtx();
	const out = c.post(run(STATUS), { isError: true, content: [{ type: 'text', text: 'tool call aborted' }] });
	assert.equal(out.kind, 'next');
});
