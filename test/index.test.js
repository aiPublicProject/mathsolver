'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MathSolver, evalExpression, runProgram, runCheck, SolverError } = require('../src/index.js');

/* ---------------- expression evaluator (variables) ---------------- */

test('evalExpression handles basic arithmetic and precedence', () => {
  assert.strictEqual(evalExpression('2*3+4'), 10);
  assert.strictEqual(evalExpression('2+3*4'), 14);
  assert.strictEqual(evalExpression('(2+3)*4'), 20);
  assert.strictEqual(evalExpression('2^3^2'), 512); // right associative
  assert.strictEqual(evalExpression('-3^2'), -9);   // unary minus binds looser than ^
  assert.strictEqual(evalExpression('10%3'), 1);
});

test('evalExpression resolves variables from env before constants', () => {
  assert.strictEqual(evalExpression('d / 2', { d: 8 }), 4);
  assert.strictEqual(evalExpression('x + y', { x: 1.5, y: 2.5 }), 4);
  assert.throws(() => evalExpression('d'), SolverError); // undefined var still errors
  assert.strictEqual(evalExpression('pi', { pi: 3 }), 3); // env shadows constant
});

test('evalExpression rejects non-arithmetic input', () => {
  for (const bad of ['process.exit(1)', '1+2)', 'foo(1)', '']) {
    assert.throws(() => evalExpression(bad), SolverError);
  }
});

/* ---------------- program interpreter ---------------- */

test('runProgram executes let-assignments and result', () => {
  const p = 'let d = 11 - 3;\nlet x = d / 2;\nresult = x';
  assert.strictEqual(runProgram(p), 4);
});

test('runProgram supports ; separators and bare final expression', () => {
  assert.strictEqual(runProgram('let a = 3; let b = 4; a * b'), 12);
  assert.strictEqual(runProgram('0.15 * 80'), 12);
});

test('runProgram rejects undefined vars, empty, no-result', () => {
  assert.throws(() => runProgram('result = undefinedvar + 1'), SolverError);
  assert.throws(() => runProgram(''), SolverError);
  assert.throws(() => runProgram('let a = 1; let b = 2'), SolverError); // no result, no bare expr
});

/* ---------------- check (substitution) ---------------- */

test('runCheck substitutes {x} and detects pass/fail', () => {
  assert.deepStrictEqual(runCheck('2*{x} + 3 - 11', 4), { value: 0, passed: true });
  const fail = runCheck('2*{x} + 3 - 12', 4);
  assert.strictEqual(fail.value, -1);
  assert.strictEqual(fail.passed, false);
  assert.strictEqual(runCheck('80*15/100 - {x}', 12).passed, true);
});

/* ---------------- solve with mocked transport ---------------- */

const GOOD = JSON.stringify({
  program: 'let d = 11 - 3;\nlet x = d / 2;\nresult = x',
  steps: ['Subtract 3: 2x = 8', 'Divide by 2: x = 4'],
  check: '2*{x} + 3 - 11',
});
const NO_CHECK = JSON.stringify({ program: 'result = 0.15 * 80', steps: ['Compute 15% of 80'] });
const WRONG_CHECK = JSON.stringify({
  program: 'let d = 11 - 3;\nresult = d / 2',
  steps: ['...'],
  check: '2*{x} + 3 - 12', // evaluates to -1, fails
});
const BROKEN_PROGRAM = JSON.stringify({ program: 'result = undefinedvar + 1', steps: [] });

test('answer comes from program execution, check passes first try', async () => {
  const calls = [];
  const transport = async (url, body, key) => {
    calls.push({ url, body, key });
    return GOOD;
  };
  const solver = new MathSolver({ apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', transport });
  const r = await solver.solve('2x + 3 = 11, solve for x');
  // 答案=执行产物(4), 代入检验=0
  assert.strictEqual(r.answer, 4);
  assert.strictEqual(r.checkValue, 0);
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.retries, 0);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.strictEqual(calls[0].body.model, 'deepseek-chat');
  // 协议确认: 模型 JSON 里没有 answer 字段
  assert.ok(!('answer' in JSON.parse(GOOD)));
});

test('no check provided → answer from execution, verified=false', async () => {
  const r = await new MathSolver({ apiKey: 'sk', transport: async () => NO_CHECK }).solve('15% of 80');
  assert.strictEqual(r.answer, 12);
  assert.strictEqual(r.verified, false);
  assert.strictEqual(r.check, null);
  assert.strictEqual(r.checkValue, null);
});

test('check fails → corrective retry → recovers', async () => {
  let n = 0;
  const transport = async () => (n++ === 0 ? WRONG_CHECK : GOOD);
  const r = await new MathSolver({ apiKey: 'sk', transport }).solve('2x+3=11');
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.retries, 1);
  assert.strictEqual(r.answer, 4);
});

test('program execution error → retry → fixed program', async () => {
  let n = 0;
  const transport = async () => (n++ === 0 ? BROKEN_PROGRAM : GOOD);
  const r = await new MathSolver({ apiKey: 'sk', transport }).solve('2x+3=11');
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.answer, 4);
});

test('program error persists after retry → PROGRAM_* error thrown', async () => {
  const transport = async () => BROKEN_PROGRAM;
  await assert.rejects(
    new MathSolver({ apiKey: 'sk', transport }).solve('2x+3=11'),
    (err) => err.code.startsWith('PROGRAM_') || err.code.startsWith('EXPR_'),
  );
});

test('invalid JSON then ok', async () => {
  let n = 0;
  const transport = async () => (n++ === 0 ? 'no json here' : GOOD);
  const r = await new MathSolver({ apiKey: 'sk', transport }).solve('1+1');
  assert.strictEqual(r.verified, true);
});

test('invalid JSON twice raises', async () => {
  await assert.rejects(
    new MathSolver({ apiKey: 'sk', transport: async () => 'nothing' }).solve('1+1'),
    (err) => err.code === 'INVALID_JSON',
  );
});

test('constructor throws NO_API_KEY / BAD_BASE_URL', () => {
  assert.throws(() => new MathSolver({}), (e) => e.code === 'NO_API_KEY');
  assert.throws(() => new MathSolver({ apiKey: 'sk', baseUrl: 'not-a-url' }), (e) => e.code === 'BAD_BASE_URL');
});

test('HTTP error propagates without retry', async () => {
  let calls = 0;
  const transport = async () => { calls++; throw new SolverError('HTTP_ERROR', '401'); };
  await assert.rejects(
    new MathSolver({ apiKey: 'sk', transport }).solve('1+1'),
    (err) => err.code === 'HTTP_ERROR',
  );
  assert.strictEqual(calls, 1);
});

test('check still failing after retry → verified=false, answer from execution', async () => {
  const r = await new MathSolver({ apiKey: 'sk', transport: async () => WRONG_CHECK }).solve('2x+3=11');
  assert.strictEqual(r.answer, 4);   // 程序执行结果
  assert.strictEqual(r.verified, false);
  assert.strictEqual(r.retries, 1);
});

/* -------- smoke: real API (set SMOKE_API_KEY to run; key never touches git) -------- */
test('smoke: real API round-trip', { skip: !process.env.SMOKE_API_KEY }, async () => {
  const solver = new MathSolver({
    apiKey: process.env.SMOKE_API_KEY,
    baseUrl: process.env.SMOKE_BASE_URL || 'https://api.openai.com/v1',
  });
  const r = await solver.solve('2x + 3 = 11, solve for x');
  console.log('smoke:', JSON.stringify({ answer: r.answer, verified: r.verified, retries: r.retries, steps: r.steps.length }));
  assert.strictEqual(r.answer, 4);
  assert.strictEqual(r.verified, true);
});
