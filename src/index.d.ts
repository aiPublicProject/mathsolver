/** BYOK AI math solver with execution-based verification (PAL-style). */

export interface SolveResult {
  /** Output of executing the model's program locally. */
  answer: number;
  steps: string[];
  /** The executed program (the answer's provenance). */
  program: string;
  /** Verification expression; null when none provided. */
  check: string | null;
  /** Evaluated check expression; null when no check provided. */
  checkValue: number | null;
  /** True only when the check expression evaluated to ~0. */
  verified: boolean;
  retries: number;
}

export interface MathSolverOptions {
  /** User's own API key (BYOK). Required. */
  apiKey: string;
  /** Any OpenAI-compatible endpoint, e.g. https://api.deepseek.com/v1. */
  baseUrl?: string;
  model?: string;
  timeout?: number;
  /** Test injection: (url, body, apiKey) -> model reply text. */
  transport?: (url: string, body: unknown, apiKey: string) => Promise<string>;
}

export declare class SolverError extends Error {
  code: string;
  constructor(code: string, message: string);
}

/** BYOK client for an OpenAI-compatible endpoint. Instantiate once, solve many. */
export declare class MathSolver {
  constructor(options?: MathSolverOptions);
  solve(problem: string): Promise<SolveResult>;
}

/** Evaluate a pure arithmetic expression; env names are case-sensitive and shadow pi/e. */
export declare function evalExpression(src: string, env?: Record<string, number>): number;

/** Execute a model-generated program (let NAME = EXPR | result = EXPR | bare EXPR). */
export declare function runProgram(src: string): number;

/** Substitute the computed answer into a check expression ({x} placeholder) and evaluate it. */
export declare function runCheck(checkSrc: string, answer: number): { value: number; passed: boolean };

export declare function parseSolverJSON(text: string): { program: string; steps: string[]; check: string | null };

export declare const SYSTEM_PROMPT: string;
