/**
 * Shared primitives for the app-core compat HTTP API (the `*-compat-routes`
 * handlers). Holds the mutable `CompatRuntimeState` container (live runtime +
 * pending restart reasons) and the helpers those routes lean on: a bounded
 * restart-reason queue, same-machine trust (`isTrustedLocalRequest`, delegating
 * to the canonical `@elizaos/shared` classifier with app-core's env gates), a
 * size-capped JSON body reader that honours a pre-parsed `req.body`, first-run
 * completion detection from persisted config, and a best-effort grab of the
 * live Drizzle DB handle. `null` from the DB grab means "service unavailable",
 * never authentication.
 */
import type http from "node:http";
import { hasPersistedFirstRunState } from "@elizaos/agent/api/server-helpers";
import { loadElizaConfig } from "@elizaos/agent/config/config";
import type { AgentRuntime } from "@elizaos/core";
import {
  type ElizaConfig,
  isLoopbackRemoteAddress,
  isTrustedLocalRequest as isTrustedLocalRequestShared,
} from "@elizaos/shared";
import { sendJsonError as sendJsonErrorResponse } from "./response.js";

const MAX_BODY_BYTES = 1_048_576;

export interface CompatRuntimeState {
  current: AgentRuntime | null;
  pendingAgentName: string | null;
  pendingRestartReasons: string[];
}

/**
 * Per-request context handed to every ordered compat-route entry. Carries the
 * pre-parsed `method`/`url` so entries do not each re-derive them, matching the
 * values the dispatcher already computed for the mode gate.
 */
export interface CompatRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  state: CompatRuntimeState;
  method: string;
  url: URL;
}

/**
 * One entry in the ordered compat-route registry (#12089 item 5). Replaces the
 * former ~30-branch fixed if-chain in `handleCompatRouteInner`: registration
 * ORDER is now the array order (data), not source line order (a hardcoded
 * if-chain). `handler` returns `true` when it fully handled the request (the
 * dispatcher then short-circuits, exactly like the old `return true`), or
 * `false` to fall through to the next entry.
 */
export interface CompatRouteChainEntry {
  /** Stable id for tests, drift guards, and per-route timing/telemetry. */
  id: string;
  handler: (ctx: CompatRouteContext) => Promise<boolean> | boolean;
}

/**
 * Iterate an ordered compat-route chain, short-circuiting on the first entry
 * that reports it handled the request. Pure over the entry list so the
 * order/short-circuit contract that used to be implicit in the if-chain is
 * now directly unit-testable. Preserves the legacy semantics exactly: entries
 * run in array order, the first `true` wins and stops the chain, and an
 * all-`false` chain returns `false` so the caller can fall through to its
 * terminal handler.
 */
export async function runCompatRouteChain(
  chain: readonly CompatRouteChainEntry[],
  ctx: CompatRouteContext,
): Promise<boolean> {
  for (const entry of chain) {
    if (await entry.handler(ctx)) {
      return true;
    }
  }
  return false;
}

export function clearCompatRuntimeRestart(state: CompatRuntimeState): void {
  state.pendingRestartReasons = [];
}

export function scheduleCompatRuntimeRestart(
  state: CompatRuntimeState,
  reason: string,
): void {
  if (state.pendingRestartReasons.includes(reason)) {
    return;
  }

  if (state.pendingRestartReasons.length >= 50) {
    state.pendingRestartReasons.splice(
      1,
      state.pendingRestartReasons.length - 1,
    );
  }

  state.pendingRestartReasons.push(reason);
}

export const DATABASE_UNAVAILABLE_MESSAGE =
  "Database not available. The agent may not be running or the database adapter is not initialized.";

// `isLoopbackRemoteAddress` is re-exported from the canonical
// `@elizaos/shared` trust module (this used to be a local duplicate). Other
// app-core modules import it from here (e.g. `dev-compat-routes.ts`,
// `server.ts`), so the name stays available on this subpath.
export { isLoopbackRemoteAddress };

/**
 * Same-machine dashboard access for the app-core compat API. Delegates to the
 * canonical `@elizaos/shared` parser with app-core's exact policy gates:
 *  - cloudCheck "env": the raw `ELIZA_CLOUD_PROVISIONED === "1"` flag (NOT the
 *    agent's stricter `isCloudProvisionedContainer()`).
 *  - requireLocalAuthEnv: honour `ELIZA_REQUIRE_LOCAL_AUTH=1`.
 *  - devAuthBypassEnv: `ELIZA_DEV_AUTH_BYPASS=1` in a dev `NODE_ENV` restores
 *    local trust (dev-ui sets this for the local dashboard).
 *
 * Intentionally stricter than a bare `remoteAddress` check: the browser must
 * also target a loopback Host and must not present cross-site browser metadata.
 */
export function isTrustedLocalRequest(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
): boolean {
  return isTrustedLocalRequestShared(req, {
    requireLocalAuthEnv: true,
    devAuthBypassEnv: true,
    cloudCheck: "env",
  });
}

export async function readCompatJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<Record<string, unknown> | null> {
  // When this handler is invoked through the runtime's plugin-route adapter
  // (rawPath: true), the runtime has already consumed the request stream and
  // attached the parsed JSON body as `req.body`. Streaming the IncomingMessage
  // again would yield zero bytes and we'd return `{}`, even though the caller
  // sent a real payload. Honour the pre-parsed body when present.
  const preParsed = (req as { body?: unknown }).body;
  if (preParsed && typeof preParsed === "object" && !Array.isArray(preParsed)) {
    return preParsed as Record<string, unknown>;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        sendJsonErrorResponse(res, 413, "Request body too large");
        return null;
      }
      chunks.push(buf);
    }
  } catch {
    sendJsonErrorResponse(res, 400, "Invalid request body");
    return null;
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendJsonErrorResponse(res, 400, "Invalid JSON body");
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendJsonErrorResponse(res, 400, "Invalid JSON body");
    return null;
  }
}

export function hasCompatPersistedFirstRunState(config: ElizaConfig): boolean {
  return hasPersistedFirstRunState(config);
}

export function getConfiguredCompatAgentName(): string | null {
  const config = loadElizaConfig();
  const listAgent = config.agents?.list?.[0];
  const listAgentName =
    typeof listAgent?.name === "string" ? listAgent.name.trim() : "";
  if (listAgentName) {
    return listAgentName;
  }

  const assistantName =
    typeof config.ui?.assistant?.name === "string"
      ? config.ui.assistant.name.trim()
      : "";
  return assistantName || null;
}

interface AdapterWithDb {
  db?: unknown;
}

/**
 * Best-effort grab of the Drizzle DB handle off the live runtime adapter.
 * Returns null when the runtime is unavailable or the adapter has not
 * exposed a `db` field. Callers MUST treat null as "service unavailable"
 * — it is never authentication.
 */
export function getCompatDrizzleDb(state: CompatRuntimeState): unknown | null {
  const runtime = state.current;
  if (!runtime) return null;
  const adapter = runtime.adapter as AdapterWithDb | undefined;
  if (!adapter?.db) return null;
  return adapter.db;
}
