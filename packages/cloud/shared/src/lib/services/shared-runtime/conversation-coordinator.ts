/**
 * Dispatches shared-runtime turns through a conversation-scoped coordinator.
 *
 * Production Workers use a Durable Object for ordered cache-local history;
 * callers must supply the namespace and execution context explicitly so a
 * deployment fault cannot fall through to repository-backed execution.
 */

import { ElizaError } from "@elizaos/core";
import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import { InsufficientCreditsError, RateLimitError } from "../../api/errors";
import type { BridgeRequest, BridgeResponse } from "../eliza-sandbox-bridge";
import type { SharedTurnMessage } from "./run-shared-agent-turn";
import type { BridgeExecutionContext } from "./shared-runtime-chat";
import { SharedRuntimeCacheWarmingError } from "./shared-runtime-errors";

export interface SharedConversationCoordinatorOptions {
  namespace: RuntimeDurableObjectNamespace;
  executionCtx: BridgeExecutionContext;
  abortSignal?: AbortSignal;
}

export interface SharedConversationHistoryCoordinatorOptions {
  namespace: RuntimeDurableObjectNamespace;
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
  if (response.status === 429) {
    const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
    throw new RateLimitError(
      (await readErrorMessage()) ?? "Organization rate limit exceeded.",
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }
  if (response.status === 409) {
    throw new ElizaError((await readErrorMessage()) ?? "Shared runtime idempotency conflict", {
      code: "SHARED_RUNTIME_IDEMPOTENCY_CONFLICT",
    });
  }
  throw new Error(`[shared-runtime] ${surface} coordinator failed (${response.status})`);
}

export async function coordinateSharedBridge(
  agent: AgentSandbox,
  rpc: BridgeRequest,
  options: SharedConversationCoordinatorOptions,
): Promise<BridgeResponse> {
  const namespace = requireTurnCoordinator(options);
  const response = await namespace
    .getByName(coordinatorName(agent.id, rpc))
    .fetch("https://shared-runtime.internal/bridge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "bridge", agent, rpc }),
    });
  await requireCoordinatorResponse(response, "conversation");
  return (await response.json()) as BridgeResponse;
}

export async function coordinateSharedStream(
  agent: AgentSandbox,
  rpc: BridgeRequest,
  options: SharedConversationCoordinatorOptions,
): Promise<Response> {
  const namespace = requireTurnCoordinator(options);
  const response = await namespace
    .getByName(coordinatorName(agent.id, rpc))
    .fetch("https://shared-runtime.internal/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "stream", agent, rpc }),
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });
  return await requireCoordinatorResponse(response, "stream");
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
