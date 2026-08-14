/**
 * Dispatches shared-runtime turns through a conversation-scoped coordinator.
 *
 * Production Workers use a Durable Object for ordered cache-local history;
 * callers must supply the namespace and execution context explicitly so a
 * deployment fault cannot fall through to repository-backed execution.
 */

import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import { InsufficientCreditsError, RateLimitError } from "../../api/errors";
import { logger } from "../../utils/logger";
import type { BridgeRequest, BridgeResponse } from "../eliza-sandbox-bridge";
import type { SharedTurnMessage } from "./run-shared-agent-turn";
import type { SharedRuntimeAgent } from "./shared-runtime-agent";
import type { BridgeExecutionContext } from "./shared-runtime-chat";
import { SharedRuntimeCacheWarmingError, SharedTurnConflictError } from "./shared-runtime-errors";

export interface SharedConversationCoordinatorOptions {
  namespace: RuntimeDurableObjectNamespace;
  executionCtx: BridgeExecutionContext;
  abortSignal?: AbortSignal;
  /** Personal operations are server-selected and always platform-funded. */
  agentKind?: "sandbox" | "personal";
}

export interface SharedConversationHistoryCoordinatorOptions {
  namespace: RuntimeDurableObjectNamespace;
}

/**
 * Hydrate one conversation object's read-only history and turn-ingress modules.
 * Voice startup uses this under its fixed greeting; no message is created.
 */
export async function coordinateSharedConversationPrewarm(
  agentId: string,
  roomId: string,
  options: SharedConversationHistoryCoordinatorOptions,
): Promise<void> {
  const namespace = requireHistoryCoordinator(options);
  const response = await coordinatorStub(namespace, agentId, roomId).fetch(
    "https://shared-runtime.internal/prewarm",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "prewarm", agentId, roomId }),
    },
  );
  await requireCoordinatorResponse(response, "conversation prewarm");
  // The Durable Object releases its per-room queue when the response body is
  // consumed. Drain this tiny acknowledgement before the first real turn.
  await response.arrayBuffer();
}

/**
 * One normalization for the Durable Object instance name. Turn dispatch and
 * history reads MUST agree — a whitespace/empty variant addressing a second
 * object would migrate the same Postgres row twice and serve a frozen copy.
 * Mirrors the room precedence in shared-runtime-chat's `channelId`.
 */
function coordinatorRoom(roomId?: unknown, userId?: unknown): string {
  const room = typeof roomId === "string" && roomId.trim() ? roomId.trim() : undefined;
  const user = typeof userId === "string" && userId.trim() ? userId.trim() : undefined;
  return room ?? user ?? "default";
}

function coordinatorName(agentId: string, rpc: BridgeRequest): string {
  return `${agentId}:${coordinatorRoom(rpc.params?.roomId, rpc.params?.userId)}`;
}

function coordinatorStub(
  namespace: RuntimeDurableObjectNamespace,
  agentId: string,
  roomId: string,
) {
  return namespace.getByName(`${agentId}:${coordinatorRoom(roomId)}`);
}

function cacheContextUnavailable(): SharedRuntimeCacheWarmingError {
  return new SharedRuntimeCacheWarmingError(
    "Shared runtime cache context is unavailable. Retry shortly.",
  );
}

function requireTurnCoordinator(
  options: SharedConversationCoordinatorOptions,
): RuntimeDurableObjectNamespace {
  if (
    !options?.namespace ||
    typeof options.namespace.getByName !== "function" ||
    !options.executionCtx ||
    typeof options.executionCtx.waitUntil !== "function"
  ) {
    throw cacheContextUnavailable();
  }
  return options.namespace;
}

function requireHistoryCoordinator(
  options: SharedConversationHistoryCoordinatorOptions,
): RuntimeDurableObjectNamespace {
  if (!options?.namespace || typeof options.namespace.getByName !== "function") {
    throw cacheContextUnavailable();
  }
  return options.namespace;
}

async function requireCoordinatorResponse(response: Response, surface: string): Promise<Response> {
  if (response.ok) return response;
  // error-policy:J3 a malformed internal error body remains an explicit typed
  // failure rather than fabricating a successful response.
  const readErrorMessage = async (): Promise<string | null> => {
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as { error?: unknown } | null;
    return typeof body?.error === "string" ? body.error : null;
  };
  if (response.status === 503) {
    throw new SharedRuntimeCacheWarmingError(
      (await readErrorMessage()) ?? "Shared runtime cache is warming. Retry shortly.",
    );
  }
  // The Durable Object encodes insufficiency as a structured 402 (class
  // identity cannot survive its fetch boundary); rehydrate the typed error so
  // route/stream callers translate it to their canonical 402 instead of a 500.
  if (response.status === 402) {
    throw new InsufficientCreditsError((await readErrorMessage()) ?? "Insufficient credits");
  }
  // A reused clientMessageId with a different payload is a structured 409 from
  // the Durable Object claim boundary; rehydrate the typed error so routes can
  // render the canonical non-retryable conflict instead of a 500.
  if (response.status === 409) {
    const message = await readErrorMessage();
    throw message ? new SharedTurnConflictError(message) : new SharedTurnConflictError();
  }
  if (response.status === 429) {
    const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
    throw new RateLimitError(
      (await readErrorMessage()) ?? "Organization rate limit exceeded.",
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }
  throw new Error(`[shared-runtime] ${surface} coordinator failed (${response.status})`);
}

export async function coordinateSharedBridge(
  agent: SharedRuntimeAgent,
  rpc: BridgeRequest,
  options: SharedConversationCoordinatorOptions,
): Promise<BridgeResponse> {
  const namespace = requireTurnCoordinator(options);
  const response = await namespace
    .getByName(coordinatorName(agent.id, rpc))
    .fetch("https://shared-runtime.internal/bridge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: options.agentKind === "personal" ? "personal-bridge" : "bridge",
        agent,
        rpc,
      }),
    });
  await requireCoordinatorResponse(response, "conversation");
  return (await response.json()) as BridgeResponse;
}

export async function coordinateSharedStream(
  agent: SharedRuntimeAgent,
  rpc: BridgeRequest,
  options: SharedConversationCoordinatorOptions,
): Promise<Response> {
  const namespace = requireTurnCoordinator(options);
  const response = await namespace
    .getByName(coordinatorName(agent.id, rpc))
    .fetch("https://shared-runtime.internal/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: options.agentKind === "personal" ? "personal-stream" : "stream",
        agent,
        rpc,
      }),
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });
  return await requireCoordinatorResponse(response, "stream");
}

export interface SharedConversationPurgeResult {
  purged: number;
  failures: number;
}

/**
 * Purge every room Durable Object of a deleted agent (#17006). Rooms share the
 * turn/history naming (`${agentId}:${room}`), so this addresses exactly the
 * objects the turn path wrote. Best-effort by contract: the agent deletion is
 * already committed when this runs, so each room is attempted independently
 * and failures are counted and logged, never thrown.
 */
export async function purgeSharedConversationRooms(
  agentId: string,
  channelIds: string[],
  options: SharedConversationHistoryCoordinatorOptions,
): Promise<SharedConversationPurgeResult> {
  const namespace = requireHistoryCoordinator(options);
  let purged = 0;
  let failures = 0;
  for (const channelId of channelIds) {
    try {
      const response = await coordinatorStub(namespace, agentId, channelId).fetch(
        "https://shared-runtime.internal/delete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operation: "delete", agentId }),
        },
      );
      if (!response.ok) {
        failures += 1;
        logger.warn("[shared-runtime] Conversation object purge returned an error", {
          agentId,
          channelId,
          status: response.status,
        });
        continue;
      }
      purged += 1;
    } catch (error) {
      // error-policy:J6 the agent row is already deleted; one room's failed
      // purge is teardown-only, logged with its room, and must not stop the
      // remaining rooms or fail the deletion that triggered it.
      failures += 1;
      logger.warn("[shared-runtime] Conversation object purge failed", {
        agentId,
        channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { purged, failures };
}

export async function coordinateSharedHistory(
  agentId: string,
  roomId: string,
  options: SharedConversationHistoryCoordinatorOptions,
): Promise<SharedTurnMessage[]> {
  const namespace = requireHistoryCoordinator(options);
  const response = await coordinatorStub(namespace, agentId, roomId).fetch(
    "https://shared-runtime.internal/history",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "history", agentId, roomId }),
    },
  );
  await requireCoordinatorResponse(response, "conversation history");
  const body = (await response.json()) as { history: SharedTurnMessage[] };
  return body.history;
}
