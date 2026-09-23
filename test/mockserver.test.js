'use strict';

/**
 * Full-stack mock: a local HTTP server imitating the OpenAI-compatible
 * /chat/completions endpoint. The client uses its DEFAULT transport (real
 * fetch) against it — URL building, auth header, request serialization,
 * response parsing and wire-level retries are all exercised. No real key.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { MathSolver } = require('../src/index.js');

const GOOD = JSON.stringify({
  program: 'let d = 11 - 3;\nlet x = d / 2;\nresult = x',
  steps: ['Subtract 3: 2x = 8', 'Divide by 2: x = 4'],
  check: '2*{x} + 3 - 11',
});
const WRONG_CHECK = JSON.stringify({
  program: 'let d = 11 - 3;\nresult = d / 2',
  steps: ['...'],
  check: '2*{x} + 3 - 12', // evaluates to -1 → must trigger a wire retry
});

function startMockServer() {
  const state = { calls: [], script: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      state.calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      const next = state.script.shift();
      if (next && typeof next === 'object' && next.status) {
        res.writeHead(next.status, { 'Content-Type': 'text/plain' });
        res.end('upstream boom');
        return;
      }
      const content = next === undefined ? GOOD : next;
      const payload = JSON.stringify({ choices: [{ message: { content } }] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

test('mock API: full HTTP round trip via default transport', async (t) => {
  const { server, state, port } = await startMockServer();
  t.after(() => server.close());

  const solver = new MathSolver({ apiKey: 'sk-mock', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' });
  const r = await solver.solve('2x + 3 = 11, solve for x');

  assert.strictEqual(r.answer, 4);
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.retries, 0);

  // 请求侧: 经过真实 HTTP 传输后服务端收到了什么
  assert.strictEqual(state.calls.length, 1);
  assert.strictEqual(state.calls[0].url, '/v1/chat/completions');
  assert.strictEqual(state.calls[0].auth, 'Bearer sk-mock');
  assert.strictEqual(state.calls[0].body.model, 'mock-model');
  assert.strictEqual(state.calls[0].body.messages[0].role, 'system');
  assert.ok(state.calls[0].body.messages[0].content.includes('STRICT JSON'));
  assert.strictEqual(state.calls[0].body.temperature, 0);
});

test('mock API: check fails → corrective retry over the wire', async (t) => {
  const { server, state, port } = await startMockServer();
  t.after(() => server.close());
  state.script = [WRONG_CHECK, GOOD];

  const r = await new MathSolver({ apiKey: 'sk', baseUrl: `http://127.0.0.1:${port}/v1` }).solve('2x+3=11');

  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.retries, 1);
  assert.strictEqual(state.calls.length, 2);
  // 第二次请求携带了纠错上下文(校验失败原因)
  const second = state.calls[1].body.messages;
  assert.ok(second.some((m) => /failed verification/.test(m.content)));
});

test('mock API: invalid JSON over the wire → re-ask → ok', async (t) => {
  const { server, state, port } = await startMockServer();
  t.after(() => server.close());
  state.script = ['certainly not json', GOOD];

  const r = await new MathSolver({ apiKey: 'sk', baseUrl: `http://127.0.0.1:${port}/v1` }).solve('1+1');
  assert.strictEqual(r.verified, true);
  assert.strictEqual(state.calls.length, 2);
});

test('mock API: HTTP 500 → HTTP_ERROR, no retry', async (t) => {
  const { server, state, port } = await startMockServer();
  t.after(() => server.close());
  state.script = [{ status: 500 }];

  await assert.rejects(
    new MathSolver({ apiKey: 'sk', baseUrl: `http://127.0.0.1:${port}/v1` }).solve('1+1'),
    (err) => err.code === 'HTTP_ERROR',
  );
  assert.strictEqual(state.calls.length, 1);
});

test('mock API: HTTP 401 → HTTP_ERROR', async (t) => {
  const { server, state, port } = await startMockServer();
  t.after(() => server.close());
  state.script = [{ status: 401 }];

  await assert.rejects(
    new MathSolver({ apiKey: 'sk-bad', baseUrl: `http://127.0.0.1:${port}/v1` }).solve('1+1'),
    (err) => err.code === 'HTTP_ERROR',
  );
});
