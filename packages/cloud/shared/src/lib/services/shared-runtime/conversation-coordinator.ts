/**
 * Dispatches shared-runtime turns through a conversation-scoped coordinator.
 *
 * Production Workers use a Durable Object for ordered cache-local history;
 * tests and non-Worker runtimes call the resolved-agent service directly.
 */

import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import type { BridgeRequest, BridgeResponse } from "../eliza-sandbox-bridge";
import type { SharedTurnMessage } from "./run-shared-agent-turn";
import type { BridgeExecutionContext } from "./shared-runtime-chat";

export interface SharedConversationCoordinatorOptions {
  namespace?: RuntimeDurableObjectNamespace;
  executionCtx?: BridgeExecutionContext;
}

function coordinatorName(agentId: string, rpc: BridgeRequest): string {
  const roomId =
    typeof rpc.params?.roomId === "string" && rpc.params.roomId.trim()
      ? rpc.params.roomId.trim()
      : typeof rpc.params?.userId === "string" && rpc.params.userId.trim()
        ? rpc.params.userId.trim()
        : "default";
  return `${agentId}:${roomId}`;
}

function coordinatorStub(
  namespace: RuntimeDurableObjectNamespace,
  agentId: string,
  roomId: string,
) {
  return namespace.getByName(`${agentId}:${roomId}`);
}

async function requireCoordinatorResponse(response: Response, surface: string): Promise<Response> {
  if (response.ok) return response;
  if (response.status === 503) {
    // error-policy:J3 a malformed internal error body remains an explicit
    // retryable failure rather than fabricating a successful response.
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as {
      error?: unknown;
    } | null;
    const error = new Error(
      typeof body?.error === "string"
        ? body.error
        : "Shared runtime cache is warming. Retry shortly.",
    );
    error.name = "SharedRuntimeCacheWarmingError";
    throw error;
  }
  throw new Error(`[shared-runtime] ${surface} coordinator failed (${response.status})`);
}

export async function coordinateSharedBridge(
  agent: AgentSandbox,
  rpc: BridgeRequest,
  options: SharedConversationCoordinatorOptions = {},
): Promise<BridgeResponse> {
  if (!options.namespace) {
    const { elizaSandboxService } = await import("../eliza-sandbox");
    return await elizaSandboxService.bridge(
      agent.id,
      agent.organization_id,
      rpc,
      options.executionCtx,
    );
  }
  const response = await options.namespace
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
  options: SharedConversationCoordinatorOptions = {},
): Promise<Response | null> {
  if (!options.namespace) {
    const { elizaSandboxService } = await import("../eliza-sandbox");
    return await elizaSandboxService.bridgeStream(agent.id, agent.organization_id, rpc);
  }
  const response = await options.namespace
    .getByName(coordinatorName(agent.id, rpc))
    .fetch("https://shared-runtime.internal/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "stream", agent, rpc }),
    });
  return await requireCoordinatorResponse(response, "stream");
}

export async function coordinateSharedHistory(
  agentId: string,
  roomId: string,
  options: SharedConversationCoordinatorOptions = {},
): Promise<SharedTurnMessage[]> {
  if (!options.namespace) {
    const { elizaSandboxService } = await import("../eliza-sandbox");
    return await elizaSandboxService.getSharedConversationHistory(agentId, roomId);
  }
  const response = await coordinatorStub(options.namespace, agentId, roomId).fetch(
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
