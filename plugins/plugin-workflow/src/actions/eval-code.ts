/**
 * EVAL_CODE — run a snippet of JavaScript in the isolated QuickJS sandbox and
 * return its result (#8914).
 *
 * Reuses the same sandbox the workflow Code node uses (`evalQuickJsCode`): a
 * throwaway QuickJS VM with a 5s deadline, a 32 MiB memory cap, and no host /
 * network / filesystem access. Owner-gated (`minRole: OWNER`) since it executes
 * caller-supplied code, even though that code can't escape the sandbox.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { evalQuickJsCode } from '../services/embedded-workflow-service';

const EVAL_CODE_CONTEXTS = ['automation', 'tasks', 'agent_internal'];

interface EvalCodeParameters {
  /** The JavaScript to run. The snippet body runs inside an IIFE, so
   * `return <value>` yields the result. */
  jsCode?: string;
  code?: string;
  /** Optional JSON exposed to the snippet as `$json` / `item.json`. */
  inputJson?: unknown;
}

function previewResult(value: unknown): string {
  try {
    if (value === undefined) return 'undefined';
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : String(value);
  } catch {
    return String(value);
  }
}

export const evalCodeAction: Action = {
  name: 'EVAL_CODE',
  contexts: [...EVAL_CODE_CONTEXTS],
  contextGate: { anyOf: [...EVAL_CODE_CONTEXTS] },
  roleGate: { minRole: 'OWNER' },
  similes: ['RUN_CODE', 'EVALUATE_CODE', 'EXEC_JS', 'RUN_JS', 'EVAL_JS'],
  description:
    'Run a snippet of JavaScript in an isolated QuickJS sandbox (5s deadline, ' +
    '32MiB cap, no network/fs/host access) and return its result. Provide a ' +
    '`jsCode` parameter; the body runs inside a function, so `return <value>` ' +
    'produces the output. Optional `inputJson` is exposed as `$json`.',
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const params = (options?.parameters ?? {}) as EvalCodeParameters;
    const jsCode = (params.jsCode ?? params.code ?? '').trim();
    if (!jsCode) {
      const text = 'EVAL_CODE requires a `jsCode` parameter (the JavaScript to run).';
      if (callback) await callback({ text });
      return { success: false, text };
    }
    try {
      const result = await evalQuickJsCode(jsCode, params.inputJson);
      const text = previewResult(result);
      if (callback) await callback({ text });
      return { success: true, text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const text = `EVAL_CODE failed: ${message}`;
      if (callback) await callback({ text });
      return { success: false, text };
    }
  },
};
