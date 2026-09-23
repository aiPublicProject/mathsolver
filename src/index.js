'use strict';

/**
 * mathsolver — BYOK AI math solver with execution-based verification (v0.2).
 *
 * Correctness model (PAL-style): the model never states the answer.
 * It returns a small JavaScript-like PROGRAM; this package executes the
 * program deterministically and the execution output IS the answer.
 * For equations, a CHECK expression ({x} placeholder) must evaluate to 0
 * when the computed answer is substituted back into the original equation.
 */

const SYSTEM_PROMPT = [
  'You are a precise math solver.',
  'Reply with STRICT JSON only, no markdown fences, in this exact shape:',
  '{"program": "<string>", "steps": [<string>, ...], "check": "<string>"}',
  'Rules:',
  '- "program" is a small JavaScript-like program that computes the final answer.',
  '  One statement per line (or ; separated). Allowed statements:',
  '      let NAME = EXPRESSION',
  '      result = EXPRESSION',
  '  EXPRESSIONs may use numbers, + - * / % ^ ( ), the functions',
  '  abs sqrt sin cos tan ln log exp floor ceil round min max',
  '  (log is base 10, ln is natural), the constants pi and e, and any',
  '  variable defined by an earlier let. The value assigned to "result"',
  '  is the answer. Never state the answer as a number in text.',
  '- "steps" is an array of short plain-language explanation strings.',
  '- "check" is a verification expression containing the placeholder {x}.',
  '  After solving, {x} is replaced by the computed answer and the whole',
  '  expression must evaluate to 0.',
  '  For equations, substitute the answer back into the original equation',
  '  (e.g. 2x+3=11 -> "2*{x}+3-11").',
  '  For arithmetic, recompute via a different path and subtract the answer',
  '  (e.g. 15% of 80 -> "80*15/100-{x}"). Provide "check" whenever possible.',
].join('\n');

const CORRECTION_PROMPT = (reason) =>
  `Your submission failed verification: ${reason}. ` +
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

/**
 * Evaluate a pure arithmetic expression string to a number.
 * @param {string} src
 * @param {Record<string, number>} [env] variable bindings from let-statements
 */
function evalExpression(src, env = {}) {
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
      const raw = tok.v;
      if (Object.prototype.hasOwnProperty.call(env, raw)) return env[raw];
      const name = raw.toLowerCase();
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
      throw new SolverError('EXPR_UNKNOWN_ID', `unknown identifier "${raw}"`);
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
/* Program interpreter (JS-dialect subset: let / assignment / result)  */
/* ------------------------------------------------------------------ */

/**
 * Execute a model-generated program. Statements (one per line or ; separated):
 *   let NAME = EXPRESSION | NAME = EXPRESSION | bare EXPRESSION
 * The answer is the value of `result`, else the last bare expression.
 * @param {string} src
 * @returns {number}
 */
function runProgram(src) {
  if (typeof src !== 'string' || !src.trim()) throw new SolverError('PROGRAM_EMPTY', 'empty program');
  const env = {};
  let resultDefined = false;
  let lastValue;
  const lines = src.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) throw new SolverError('PROGRAM_EMPTY', 'empty program');
  for (const line of lines) {
    let m = line.match(/^let\s+([a-zA-Z_]\w*)\s*=\s*([\s\S]+)$/);
    if (m) {
      env[m[1]] = evalExpression(m[2], env);
      if (m[1] === 'result') resultDefined = true;
      continue;
    }
    m = line.match(/^([a-zA-Z_]\w*)\s*=\s*([\s\S]+)$/);
    if (m) {
      env[m[1]] = evalExpression(m[2], env);
      if (m[1] === 'result') resultDefined = true;
      continue;
    }
    lastValue = evalExpression(line, env);
  }
  if (resultDefined) return env.result;
  if (lastValue !== undefined) return lastValue;
  throw new SolverError('PROGRAM_NO_RESULT', 'program produced no result');
}

/**
 * Substitute the computed answer into a check expression ({x} placeholder)
 * and evaluate. Passes when the value is ~0 (scaled tolerance).
 * @returns {{value: number, passed: boolean}}
 */
function runCheck(checkSrc, answer) {
  const substituted = String(checkSrc).replace(/\{\s*x\s*\}/gi, `(${answer})`);
  const value = evalExpression(substituted);
  const passed = Math.abs(value) <= 1e-6 * Math.max(1, Math.abs(answer));
  return { value, passed };
}

/* ------------------------------------------------------------------ */
/* JSON extraction                                                     */
/* ------------------------------------------------------------------ */

function parseSolverJSON(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) throw new SolverError('INVALID_JSON', 'model reply contained no JSON object');
  let data;
  try { data = JSON.parse(match[0]); } catch { throw new SolverError('INVALID_JSON', 'model reply was not valid JSON'); }
  if (typeof data.program !== 'string') {
    throw new SolverError('INVALID_JSON', 'model JSON is missing "program"');
  }
  return {
    program: data.program,
    steps: Array.isArray(data.steps) ? data.steps.map(String) : [],
    check: typeof data.check === 'string' && data.check.trim() ? data.check : null,
  };
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
/* Client                                                              */
/* ------------------------------------------------------------------ */

/**
 * BYOK client for an OpenAI-compatible endpoint. Instantiate once, solve many.
 *
 * @example
 *   const { MathSolver } = require('mathsolver');
 *   const solver = new MathSolver({ apiKey: 'sk-...', baseUrl: 'https://api.deepseek.com/v1' });
 *   const r = await solver.solve('2x + 3 = 11, solve for x');
 *   // { answer: 4, verified: true, ... } — answer comes from executing the
 *   // model-generated program locally, never from a number the model stated.
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
   * Solve a math problem. The answer is the output of executing the model's
   * program; `verified` is true only when the check expression passes
   * (equations: answer substituted back must satisfy the original equation).
   * @param {string} problem
   * @returns {Promise<{answer:number, steps:string[], program:string, check:(string|null), checkValue:(number|null), verified:boolean, retries:number}>}
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
      messages.push({ role: 'assistant', content: 'invalid JSON' },
                    { role: 'user', content: 'Your reply was not valid JSON. Reply again with the exact strict JSON shape.' });
      parsed = parseSolverJSON(await call()); // second failure throws
    }

    // attempt: execute program + run check. Never throws; reports ok/error.
    const attempt = (p) => {
      try {
        const answer = runProgram(p.program);
        let checkValue = null;
        let verified = false;
        if (p.check) {
          const r = runCheck(p.check, answer);
          checkValue = r.value;
          verified = r.passed;
        }
        return { ok: true, answer, checkValue, verified };
      } catch (err) {
        return { ok: false, error: err };
      }
    };

    let outcome = attempt(parsed);
    let retries = 0;
    if (!outcome.ok || !outcome.verified) {
      retries = 1;
      const reason = !outcome.ok
        ? `program failed to execute (${outcome.error.code}: ${outcome.error.message})`
        : `check evaluated to ${outcome.checkValue} instead of 0`;
      messages.push({ role: 'assistant', content: JSON.stringify(parsed) },
                    { role: 'user', content: CORRECTION_PROMPT(reason) });
      const secondParsed = parseSolverJSON(await call());
      const second = attempt(secondParsed);
      if (!second.ok) throw second.error; // PROGRAM_* error persisted after retry
      parsed = secondParsed;
      outcome = second;
    }

    return {
      answer: outcome.answer,
      steps: parsed.steps,
      program: parsed.program,
      check: parsed.check,
      checkValue: outcome.checkValue,
      verified: outcome.verified,
      retries,
    };
  }
}

module.exports = { MathSolver, evalExpression, runProgram, runCheck, parseSolverJSON, SolverError, SYSTEM_PROMPT };
