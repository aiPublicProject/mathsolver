'use strict';

/**
 * mathsolver — BYOK AI math solver with independent verification.
 *
 * Core promise: an answer is only marked `verified: true` when a pure
 * arithmetic expression (returned by the model alongside the answer) is
 * evaluated locally by this package and matches the answer numerically.
 * No model output is ever executed as code.
 */

const SYSTEM_PROMPT = [
  'You are a precise math solver.',
  'Reply with STRICT JSON only, no markdown fences, in this exact shape:',
  '{"answer": <number>, "steps": [<string>, ...], "verification": {"expression": "<string>"}}',
  'Rules:',
  '- "answer" must be a single number (the final result).',
  '- "steps" must be an array of short plain-language explanation strings.',
  '- "verification.expression" must be a pure arithmetic expression that',
  '  evaluates to the answer. Allowed: numbers, + - * / % ^ ( ), and the',
  '  functions abs sqrt sin cos tan ln log exp floor ceil round min max',
  '  (log is base 10, ln is natural), and the constants pi and e.',
  '- The expression must recompute the answer independently.',
].join('\n');

const CORRECTION_PROMPT = (evaluated, answer) =>
  `Your verification expression evaluated to ${evaluated}, which does not match your answer ${answer}. ` +
  'Re-derive the problem carefully and reply again with the same strict JSON shape.';

class SolverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SolverError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Expression evaluator (recursive descent, no eval, no deps)          */
/* ------------------------------------------------------------------ */

const FUNCS = {
  abs: Math.abs, sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  ln: Math.log, log: Math.log10, exp: Math.exp,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: (...a) => Math.min(...a), max: (...a) => Math.max(...a),
};
const CONSTS = { pi: Math.PI, e: Math.E };

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      // scientific notation: 1e-3 / 2E5
      if (/[eE]/.test(src[j] || '') && /[0-9+-]/.test(src[j + 1] || '')) {
        j++;
        if (/[+-]/.test(src[j] || '')) j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      const num = Number(src.slice(i, j));
      if (!Number.isFinite(num)) throw new SolverError('EXPR_BAD_NUMBER', `bad number at ${i}`);
      tokens.push({ t: 'num', v: num });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[a-zA-Z_0-9]/.test(src[j])) j++;
      tokens.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/%^(),'.includes(ch)) { tokens.push({ t: ch }); i++; continue; }
    throw new SolverError('EXPR_BAD_CHAR', `unexpected character "${ch}"`);
  }
  return tokens;
}

/** Evaluate a pure arithmetic expression string to a number. Throws on anything else. */
function evalExpression(src) {
  if (typeof src !== 'string' || !src.trim()) throw new SolverError('EXPR_EMPTY', 'empty expression');
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const eat = (t) => {
    const tok = toks[pos];
    if (!tok || (t !== undefined && tok.t !== t)) throw new SolverError('EXPR_SYNTAX', `expected ${t ?? 'more tokens'}`);
    pos++;
    return tok;
  };
  function parseExpr() {
    let v = parseTerm();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = eat().t;
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function parseTerm() {
    let v = parseUnary();
    while (peek() && (peek().t === '*' || peek().t === '/' || peek().t === '%')) {
      const op = eat().t;
      const r = parseUnary();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function parseUnary() {
    if (peek() && peek().t === '-') { eat('-'); return -parseUnary(); }
    if (peek() && peek().t === '+') { eat('+'); return parseUnary(); }
    return parsePower();
  }
  function parsePower() {
    const base = parseAtom();
    if (peek() && peek().t === '^') {
      eat('^');
      const exp = parseUnary(); // right associative, binds tighter than unary minus
      return Math.pow(base, exp);
    }
    return base;
  }
  function parseAtom() {
    const tok = peek();
    if (!tok) throw new SolverError('EXPR_SYNTAX', 'unexpected end of expression');
    if (tok.t === 'num') { eat('num'); return tok.v; }
    if (tok.t === 'id') {
      eat('id');
      const name = tok.v.toLowerCase();
      if (peek() && peek().t === '(') {
        eat('(');
        const args = [parseExpr()];
        while (peek() && peek().t === ',') { eat(','); args.push(parseExpr()); }
        eat(')');
        const fn = FUNCS[name];
        if (!fn) throw new SolverError('EXPR_UNKNOWN_FUNC', `unknown function "${name}"`);
        return fn(...args);
      }
      if (name in CONSTS) return CONSTS[name];
      throw new SolverError('EXPR_UNKNOWN_ID', `unknown identifier "${name}"`);
    }
    if (tok.t === '(') {
      eat('(');
      const v = parseExpr();
      eat(')');
      return v;
    }
    throw new SolverError('EXPR_SYNTAX', `unexpected token "${tok.t}"`);
  }
  const value = parseExpr();
  if (pos !== toks.length) throw new SolverError('EXPR_TRAILING', 'trailing tokens in expression');
  if (!Number.isFinite(value)) throw new SolverError('EXPR_NON_FINITE', 'expression evaluated to non-finite value');
  return value;
}

/* ------------------------------------------------------------------ */
/* JSON extraction + answer coercion                                   */
/* ------------------------------------------------------------------ */

function parseSolverJSON(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) throw new SolverError('INVALID_JSON', 'model reply contained no JSON object');
  let data;
  try { data = JSON.parse(match[0]); } catch { throw new SolverError('INVALID_JSON', 'model reply was not valid JSON'); }
  if (typeof data.answer !== 'number' && typeof data.answer !== 'string') {
    throw new SolverError('INVALID_JSON', 'model JSON is missing a numeric "answer"');
  }
  if (!data.verification || typeof data.verification.expression !== 'string') {
    throw new SolverError('INVALID_JSON', 'model JSON is missing verification.expression');
  }
  return {
    answer: typeof data.answer === 'string' ? Number(String(data.answer).replace(/[^0-9.eE+-]/g, '')) : data.answer,
    steps: Array.isArray(data.steps) ? data.steps.map(String) : [],
    expression: data.verification.expression,
  };
}

function numericallyEqual(a, b, relTol = 1e-6) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= relTol * Math.max(1, Math.abs(a), Math.abs(b));
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

async function defaultTransport(url, body, apiKey) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new SolverError('HTTP_ERROR', `API responded ${res.status}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new SolverError('HTTP_ERROR', 'API response missing message content');
  return content;
}

/* ------------------------------------------------------------------ */
/* solve                                                               */
/* ------------------------------------------------------------------ */

/**
 * BYOK client for an OpenAI-compatible endpoint. Instantiate once, solve many.
 *
 * @example
 *   const { MathSolver } = require('mathsolver');
 *   const solver = new MathSolver({ apiKey: 'sk-...', baseUrl: 'https://api.deepseek.com/v1' });
 *   const r = await solver.solve('2x + 3 = 11, solve for x'); // { answer: 4, verified: true, ... }
 */
class MathSolver {
  constructor({ apiKey, baseUrl = 'https://api.openai.com/v1', model = 'gpt-4o-mini', timeout = 60000, transport } = {}) {
    if (!apiKey) throw new SolverError('NO_API_KEY', 'options.apiKey is required (BYOK: bring your own key)');
    if (!/^https?:\/\//.test(baseUrl)) throw new SolverError('BAD_BASE_URL', 'baseUrl must be an http(s) URL, e.g. https://api.deepseek.com/v1');
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.model = model;
    this.timeout = timeout;
    this._transport = transport || defaultTransport;
  }

  /**
   * Solve a math problem. The answer is only `verified: true` when the model's
   * verification expression independently re-evaluates (locally) to the same number.
   * @param {string} problem - e.g. "2x + 3 = 11, solve for x"
   * @returns {Promise<{answer:number, steps:string[], expression:string, evaluated:number, verified:boolean, retries:number}>}
   */
  async solve(problem) {
    const { apiKey, model, _transport: transport } = this;
    if (typeof problem !== 'string' || !problem.trim()) throw new SolverError('NO_PROBLEM', 'problem must be a non-empty string');
    const url = `${this.baseUrl}/chat/completions`;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: problem },
  ];
  const call = () => transport(url, { model, messages, temperature: 0 }, apiKey);

  let parsed;
  try {
    parsed = parseSolverJSON(await call());
  } catch (err) {
    if (err.code !== 'INVALID_JSON') throw err;
    messages.push({ role: 'assistant', content: 'invalid JSON' }, { role: 'user', content: 'Your reply was not valid JSON. Reply again with the exact strict JSON shape.' });
    parsed = parseSolverJSON(await call()); // second failure throws
  }

  let evaluated = null;
  let verified = false;
  try {
    evaluated = evalExpression(parsed.expression);
    verified = numericallyEqual(evaluated, parsed.answer);
  } catch {
    verified = false;
  }

  let retries = 0;
  if (!verified) {
    retries = 1;
    messages.push({ role: 'assistant', content: JSON.stringify({ ...parsed, verification: { expression: parsed.expression } }) },
                   { role: 'user', content: CORRECTION_PROMPT(evaluated ?? 'an error', parsed.answer) });
    try {
      const second = parseSolverJSON(await call());
      evaluated = evalExpression(second.expression);
      verified = numericallyEqual(evaluated, second.answer);
      if (verified || numericallyEqual(evaluated, second.answer)) parsed = second;
    } catch {
      /* keep first attempt; verified stays false */
    }
  }

  return { ...parsed, evaluated, verified, retries };
  }
}

module.exports = { MathSolver, solve: deprecatedSolve, evalExpression, parseSolverJSON, numericallyEqual, SolverError, SYSTEM_PROMPT };

/** @deprecated use `new MathSolver(...)` instead. */
async function deprecatedSolve(problem, opts = {}) { return new MathSolver(opts).solve(problem); }
