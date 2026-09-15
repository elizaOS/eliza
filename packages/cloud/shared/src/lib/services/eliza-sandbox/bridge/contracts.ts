/** Defines sandbox JSON-RPC bridge requests, responses, runtime status summaries, and transport failure identities shared by the active bridge and service facade. */

export interface BridgeRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Structural subset of the Cloudflare Workers `ExecutionContext` the shared-tier
 * bridge needs to defer its post-reply billing tail off the response path.
 * Routes pass `c.executionCtx`; non-Worker callers (tests, Node) omit it and
 * the tail runs inline, preserving fully-synchronous settlement.
 */
export type BridgeExecutionContext = { waitUntil(promise: Promise<unknown>): void };

/**
 * JSON-RPC error code for a shared-runtime turn rejected by the credit
 * reserve. REST callers (shared-rest-adapter, the messages/stream route)
 * match on this code to translate the failure into the canonical 402
 * insufficient-credits response instead of a generic retryable failure —
 * an empty balance is permanent until the org tops up, not a transient
 * outage.
 */
export const BRIDGE_INSUFFICIENT_CREDITS_CODE = -32002;

export interface BridgeResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export type RuntimeAgentSummary = {
  id?: string;
  name?: string;
  status?: string;
};

export type RuntimeAgentListResult = {
  supported: boolean;
  agents: RuntimeAgentSummary[];
};

export const DEFAULT_CENTRAL_SERVER_ID = "00000000-0000-0000-0000-000000000000";

export class BridgeRouteUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BridgeRouteUnavailableError";
  }
}
