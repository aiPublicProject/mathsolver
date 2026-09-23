'use strict';

/**
 * HTTP-interface mock (no server, no sockets): stub globalThis.fetch so the
 * client's DEFAULT transport runs its real code path (URL building, headers,
 * body serialization, res.ok handling, res.json() parsing) against synthetic
 * OpenAI-shaped responses. Runs identically in local dev and GitHub CI.
 */

const test = require('node:test');
const assert = require('node:assert');
const { MathSolver } = require('../src/index.js');

const GOOD = JSON.stringify({
  program: 'let d = 11 - 3;\nlet x = d / 2;\nresult = x',
  steps: ['Subtract 3: 2x = 8', 'Divide by 2: x = 4'],
  check: '2*{x} + 3 - 11',
});
const WRONG_CHECK = JSON.stringify({
  program: 'let d = 11 - 3;\nresult = d / 2',
  steps: ['...'],
  check: '2*{x} + 3 - 12', // evaluates to -1 → must trigger a retry
});

async function withMockHttp(script, fn) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {}, body: JSON.parse(init.body) });
    const next = script.shift();
    if (next && typeof next === 'object' && next.status) {
      return new Response('upstream boom', { status: next.status });
    }
    const content = next === undefined ? GOOD : next;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('http mock: full round trip via default transport (fetch stubbed)', async () => {
  await withMockHttp([GOOD], async (calls) => {
    const solver = new MathSolver({ apiKey: 'sk-mock', baseUrl: 'https://mock.test/v1', model: 'mock-model' });
    const r = await solver.solve('2x + 3 = 11, solve for x');

    assert.strictEqual(r.answer, 4);
    assert.strictEqual(r.verified, true);
    assert.strictEqual(r.retries, 0);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://mock.test/v1/chat/completions');
    assert.strictEqual(calls[0].headers.Authorization, 'Bearer sk-mock');
    assert.strictEqual(calls[0].body.model, 'mock-model');
    assert.strictEqual(calls[0].body.messages[0].role, 'system');
    assert.ok(calls[0].body.messages[0].content.includes('STRICT JSON'));
    assert.strictEqual(calls[0].body.temperature, 0);
  });
});

test('http mock: check fails → corrective retry', async () => {
  await withMockHttp([WRONG_CHECK, GOOD], async (calls) => {
    const r = await new MathSolver({ apiKey: 'sk', baseUrl: 'https://mock.test/v1' }).solve('2x+3=11');
    assert.strictEqual(r.verified, true);
    assert.strictEqual(r.retries, 1);
    assert.strictEqual(calls.length, 2);
    assert.ok(calls[1].body.messages.some((m) => /failed verification/.test(m.content)));
  });
});

test('http mock: invalid JSON → re-ask → ok', async () => {
  await withMockHttp(['certainly not json', GOOD], async (calls) => {
    const r = await new MathSolver({ apiKey: 'sk', baseUrl: 'https://mock.test/v1' }).solve('1+1');
    assert.strictEqual(r.verified, true);
    assert.strictEqual(calls.length, 2);
  });
});

test('http mock: 500 → HTTP_ERROR no retry', async () => {
  await withMockHttp([{ status: 500 }], async (calls) => {
    await assert.rejects(
      new MathSolver({ apiKey: 'sk', baseUrl: 'https://mock.test/v1' }).solve('1+1'),
      (err) => err.code === 'HTTP_ERROR',
    );
    assert.strictEqual(calls.length, 1);
  });
});

test('http mock: 401 → HTTP_ERROR', async () => {
  await withMockHttp([{ status: 401 }], async () => {
    await assert.rejects(
      new MathSolver({ apiKey: 'sk-bad', baseUrl: 'https://mock.test/v1' }).solve('1+1'),
      (err) => err.code === 'HTTP_ERROR',
    );
  });
});
