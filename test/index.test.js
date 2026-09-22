'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MathSolver, evalExpression, SolverError } = require('../src/index.js');

/* ---------------- expression evaluator unit tests ---------------- */

test('evalExpression handles basic arithmetic and precedence', () => {
  assert.strictEqual(evalExpression('2*3+4'), 10);
  assert.strictEqual(evalExpression('2+3*4'), 14);
  assert.strictEqual(evalExpression('(2+3)*4'), 20);
  assert.strictEqual(evalExpression('2^3^2'), 512); // right associative
  assert.strictEqual(evalExpression('-3^2'), -9);   // unary minus binds looser than ^
  assert.strictEqual(evalExpression('10%3'), 1);
});

test('evalExpression handles functions and constants', () => {
  assert.strictEqual(evalExpression('sqrt(16)'), 4);
  assert.strictEqual(evalExpression('abs(-5)'), 5);
  assert.strictEqual(evalExpression('min(3,5)'), 3);
  assert.strictEqual(evalExpression('max(3,5)'), 5);
  assert.strictEqual(evalExpression('floor(2.7)'), 2);
  assert.ok(Math.abs(evalExpression('pi') - Math.PI) < 1e-12);
  assert.ok(Math.abs(evalExpression('log(1000)') - 3) < 1e-12);
  assert.ok(Math.abs(evalExpression('ln(e)') - 1) < 1e-12);
});

test('evalExpression rejects non-arithmetic input', () => {
  assert.throws(() => evalExpression('process.exit(1)'), SolverError);
  assert.throws(() => evalExpression('1+2)'), SolverError);
  assert.throws(() => evalExpression('foo(1)'), SolverError);
  assert.throws(() => evalExpression(''), SolverError);
});

/* ---------------- solve() with mocked transport ---------------- */

const goodBody = {
  choices: [{ message: { content: JSON.stringify({
    answer: 4,
    steps: ['Subtract 3 from both sides: 2x = 8', 'Divide by 2: x = 4'],
    verification: { expression: '(11-3)/2' },
  }) } }],
};
const wrongThenRight = {
  choices: [{ message: { content: JSON.stringify({
    answer: 4,
    steps: ['...'],
    verification: { expression: '(11-3)/3' }, // evaluates to 2.666..., mismatch
  }) } }],
};
const correctedBody = {
  choices: [{ message: { content: JSON.stringify({
    answer: 4,
    steps: ['Subtract 3: 2x=8', 'Divide by 2: x=4'],
    verification: { expression: '(11-3)/2' },
  }) } }],
};

test('MathSolver.solve verifies on first attempt (no retry)', async () => {
  const calls = [];
  const transport = async (url, body, key) => {
    calls.push({ url, body, key });
    return goodBody.choices[0].message.content;
  };
  const solver = new MathSolver({ apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', transport });
  const result = await solver.solve('2x + 3 = 11, solve for x');
  assert.strictEqual(result.answer, 4);
  assert.strictEqual(result.evaluated, 4);
  assert.strictEqual(result.verified, true);
  assert.strictEqual(result.retries, 0);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].key, 'sk-test');
  assert.strictEqual(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.strictEqual(calls[0].body.model, 'deepseek-chat');
});

test('solve retries once on verification mismatch and recovers', async () => {
  let n = 0;
  const transport = async () => {
    n++;
    return n === 1 ? wrongThenRight.choices[0].message.content : correctedBody.choices[0].message.content;
  };
  const result = await new MathSolver({ apiKey: 'sk-test', transport }).solve('2x + 3 = 11');
  assert.strictEqual(result.verified, true);
  assert.strictEqual(result.retries, 1);
  assert.strictEqual(result.evaluated, 4);
});

test('solve retries once on invalid JSON, then succeeds', async () => {
  let n = 0;
  const transport = async () => {
    n++;
    return n === 1 ? 'sure! the answer is {"answer": 4, "steps": [], "verification": {"expression": "8/2"}} oops{' : goodBody.choices[0].message.content;
  };
  const result = await new MathSolver({ apiKey: 'sk-test', transport }).solve('2x+3=11');
  assert.strictEqual(result.verified, true);
});

test('solve throws INVALID_JSON when both replies are garbage', async () => {
  const transport = async () => 'I cannot answer that.';
  await assert.rejects(new MathSolver({ apiKey: 'sk', transport }).solve('1+1'), (err) => err.code === 'INVALID_JSON');
});

test('solve propagates HTTP errors without retry', async () => {
  const transport = async () => { throw new SolverError('HTTP_ERROR', 'API responded 401'); };
  await assert.rejects(new MathSolver({ apiKey: 'sk', transport }).solve('1+1'), (err) => err.code === 'HTTP_ERROR');
});

test('constructor throws NO_API_KEY before any network call', () => {
  let called = false;
  const transport = async () => { called = true; return ''; };
  assert.throws(() => new MathSolver({ transport }), (err) => err.code === 'NO_API_KEY');
  assert.strictEqual(called, false);
});

test('constructor rejects bad baseUrl', () => {
  assert.throws(() => new MathSolver({ apiKey: 'sk', baseUrl: 'not-a-url' }), (err) => err.code === 'BAD_BASE_URL');
});

test('solve returns verified:false when retry still mismatches', async () => {
  const transport = async () => wrongThenRight.choices[0].message.content;
  const result = await new MathSolver({ apiKey: 'sk', transport }).solve('2x+3=11');
  assert.strictEqual(result.verified, false);
  assert.strictEqual(result.retries, 1);
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
