'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { solve, evalExpression, SolverError } = require('../src/index.js');

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

test('solve verifies on first attempt (no retry)', async () => {
  const calls = [];
  const transport = async (url, body, key) => {
    calls.push({ url, body, key });
    return goodBody.choices[0].message.content;
  };
  const result = await solve('2x + 3 = 11, solve for x', { apiKey: 'sk-test', transport });
  assert.strictEqual(result.answer, 4);
  assert.strictEqual(result.evaluated, 4);
  assert.strictEqual(result.verified, true);
  assert.strictEqual(result.retries, 0);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].key, 'sk-test');
  assert.ok(calls[0].url.endsWith('/chat/completions'));
});

test('solve retries once on verification mismatch and recovers', async () => {
  let n = 0;
  const transport = async () => {
    n++;
    return n === 1 ? wrongThenRight.choices[0].message.content : correctedBody.choices[0].message.content;
  };
  const result = await solve('2x + 3 = 11', { apiKey: 'sk-test', transport });
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
  const result = await solve('2x+3=11', { apiKey: 'sk-test', transport });
  assert.strictEqual(result.verified, true);
});

test('solve throws INVALID_JSON when both replies are garbage', async () => {
  const transport = async () => 'I cannot answer that.';
  await assert.rejects(solve('1+1', { apiKey: 'sk', transport }), (err) => err.code === 'INVALID_JSON');
});

test('solve propagates HTTP errors without retry', async () => {
  const transport = async () => { throw new SolverError('HTTP_ERROR', 'API responded 401'); };
  await assert.rejects(solve('1+1', { apiKey: 'sk', transport }), (err) => err.code === 'HTTP_ERROR');
});

test('solve throws NO_API_KEY before any network call', async () => {
  let called = false;
  const transport = async () => { called = true; return ''; };
  await assert.rejects(solve('1+1', { transport }), (err) => err.code === 'NO_API_KEY');
  assert.strictEqual(called, false);
});

test('solve returns verified:false when retry still mismatches', async () => {
  const transport = async () => wrongThenRight.choices[0].message.content;
  const result = await solve('2x+3=11', { apiKey: 'sk', transport });
  assert.strictEqual(result.verified, false);
  assert.strictEqual(result.retries, 1);
});
