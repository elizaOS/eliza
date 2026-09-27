/**
 * plugin-automaton-token-safety — ElizaOS plugin with 5 Zod-typed actions for Base token safety,
 * paid per call with x402 (USDC, gas sponsored by the CDP facilitator).
 * Settings: AUTOMATON_SIGNER_KEY (optional), AUTOMATON_MAX_UNITS, AUTOMATON_API_BASE, AUTOMATON_DRY_RUN.
 * Input: options.params or message.content.params.
 */
import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, Plugin, State, HandlerOptions, ProviderDataRecord, ProviderValue, JsonValue } from '@elizaos/core';
import { ROUTES, type RouteId } from './routes.js';
import { inputSchemas } from './schemas.js';
import { createX402Client, signerFromKey, GuardError, type CallResult, type TypedDataSigner } from './client.js';

export { ROUTES, inputSchemas, createX402Client };
export type { RouteId, CallResult, TypedDataSigner };

const ACTIONS: Array<[RouteId, string, string[]]> = [
  ['scan', 'AUTOMATON_SCAN', ['TOKEN_SCAN', 'HONEYPOT_CHECK', 'CONTRACT_SECURITY_SCAN']],
  ['sentinel-latest', 'AUTOMATON_SENTINEL_LATEST', ['NEW_BASE_POOLS', 'NEW_TOKENS_BASE']],
  ['approval-risk', 'AUTOMATON_APPROVAL_RISK', ['APPROVAL_AUDIT', 'ALLOWANCE_RISK', 'DRAIN_RISK']],
  ['simulate', 'AUTOMATON_SIMULATE', ['SIMULATE_TRADE', 'HONEYPOT_SIMULATION', 'TRANSFER_TAX']],
  ['liquidity-risk', 'AUTOMATON_LIQUIDITY_RISK', ['LIQUIDITY_DEPTH', 'LP_LOCK_CHECK', 'POOL_RISK']]
];

const EXAMPLE_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const EXAMPLE_PARAMS: Record<RouteId, Record<string, JsonValue>> = {
  scan: { address: EXAMPLE_TOKEN },
  'sentinel-latest': { limit: 10, maxRisk: 30 },
  'approval-risk': { token: EXAMPLE_TOKEN, owner: '0x000000000000000000000000000000000000dEaD' },
  simulate: { token: EXAMPLE_TOKEN, side: 'buy', amount: '0.001', wallet: '0x000000000000000000000000000000000000dEaD' },
  'liquidity-risk': { token: EXAMPLE_TOKEN }
};

export interface PluginOptions {
  signer?: TypedDataSigner | null;
  fetchImpl?: typeof fetch;
  settings?: Record<string, string | undefined>;
}

function summarize(route: RouteId, r: CallResult): string {
  if (r.dryRun) return `Dry run: signed an authorization for ${r.amountUnits} USDC units; paid request NOT sent.`;
  if (r.status === 402) return `Payment required for ${ROUTES[route].path} (set AUTOMATON_SIGNER_KEY to pay with x402).`;
  const d = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, any>;
  const v = d.verdict || d.overallRisk || d.summary?.verdict || (Array.isArray(d.pools) ? `${d.pools.length} pools` : `HTTP ${r.status}`);
  return `${ROUTES[route].path}: ${v}`;
}

export function createAutomatonPlugin(opts: PluginOptions = {}): Plugin {
  const setting = (runtime: IAgentRuntime | undefined, k: string): string | undefined => {
    if (opts.settings && opts.settings[k] !== undefined) return opts.settings[k];
    const fromRuntime = runtime && typeof runtime.getSetting === 'function' ? runtime.getSetting(k) : undefined;
    return (fromRuntime !== undefined && fromRuntime !== null ? String(fromRuntime) : undefined) || process.env[k];
  };

  const actions: Action[] = ACTIONS.map(([route, name, similes]): Action => ({
    name,
    similes,
    description: `${ROUTES[route].description} Paid per call via x402 (about $${ROUTES[route].priceUsd}, USDC on Base, no ETH needed).`,
    inputSchema: inputSchemas[route],
    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => !!message,
    handler: async (runtime: IAgentRuntime, message: Memory, _state?: State, options?: HandlerOptions, callback?: HandlerCallback): Promise<ActionResult> => {
      const content = (message?.content ?? {}) as Record<string, unknown>;
      const raw = (options?.params as Record<string, unknown> | undefined) ?? (content.params as Record<string, unknown> | undefined) ?? {};
      const parsed = inputSchemas[route].safeParse(raw);
      if (!parsed.success) {
        const text = `Invalid input for ${name}: ` + parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
        if (callback) await callback({ text });
        return { success: false, text, error: 'invalid_input' };
      }
      try {
        const key = setting(runtime, 'AUTOMATON_SIGNER_KEY');
        const client = createX402Client({
          baseUrl: setting(runtime, 'AUTOMATON_API_BASE'),
          signer: opts.signer ?? (key ? await signerFromKey(key) : null),
          maxAmountUnits: Number(setting(runtime, 'AUTOMATON_MAX_UNITS') || 10000),
          fetchImpl: opts.fetchImpl
        });
        const r = await client.call(route, parsed.data as Record<string, unknown>, { dryRun: setting(runtime, 'AUTOMATON_DRY_RUN') === '1' });
        const text = summarize(route, r);
        const data: ProviderDataRecord = { route: ROUTES[route].path, status: r.status, paid: r.paid, dryRun: !!r.dryRun, amountUnits: r.amountUnits ?? null, result: (r.data ?? null) as ProviderValue };
        if (callback) await callback({ text, actions: [name] });
        return { success: r.status === 200, text, data };
      } catch (e) {
        const err = e as Error;
        const code = e instanceof GuardError ? e.code : 'request_failed';
        const text = `${name} failed: ${err.message}`;
        if (callback) await callback({ text });
        return { success: false, text, error: code };
      }
    },
    examples: [[
      { name: '{{user1}}', content: { text: `Run ${name} on ${EXAMPLE_TOKEN}`, params: EXAMPLE_PARAMS[route] } },
      { name: '{{agent}}', content: { text: `Calling ${ROUTES[route].path} (x402, gasless).`, actions: [name] } }
    ]]
  }));

  return {
    name: 'plugin-automaton-token-safety',
    description: 'Base token safety intelligence (scan, approvals, trade simulation, liquidity, new pools) paid per call with x402 USDC; gasless for the agent.',
    actions,
    providers: [],
    evaluators: []
  };
}

const automatonPlugin: Plugin = createAutomatonPlugin();
export default automatonPlugin;
