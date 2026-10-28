/**
 * Structural contract for the agent-event service plus a runtime resolver.
 * Declares the event/heartbeat payload shapes and a duck-typed
 * AgentEventServiceLike interface, and resolves that service off a runtime by
 * probing the known service-type aliases — decoupling consumers from the
 * concrete service class.
 */
import type { AgentEventInput, IAgentRuntime, UUID } from "@elizaos/core";

/** In-process only: symbols survive local event delivery but never JSON/model context. */
export const AUTONOMY_NOTIFICATION_DELIVERY = Symbol(
  "autonomy-notification-delivery",
);
export interface AutonomyNotificationDelivery {
  publish: (target?: {
    conversationId: string;
    messageId: string;
  }) => Promise<unknown>;
  routed?: Promise<void>;
}

export interface AgentEventPayloadLike {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
  agentId?: string;
  roomId?: UUID;
}

export interface HeartbeatEventPayloadLike {
  ts: number;
  status: string;
  to?: string;
  preview?: string;
  durationMs?: number;
  hasMedia?: boolean;
  reason?: string;
  channel?: string;
  silent?: boolean;
  indicatorType?: string;
}

export interface AgentEventServiceLike {
  emit?: (event: AgentEventInput) => void;
  subscribe: (listener: (event: AgentEventPayloadLike) => void) => () => void;
  subscribeHeartbeat: (
    listener: (event: HeartbeatEventPayloadLike) => void,
  ) => () => void;
  getLastHeartbeat?: () => HeartbeatEventPayloadLike | null;
}

type RuntimeWithServiceGetter = {
  getService: (serviceType: string) => unknown | null;
};

export const AGENT_EVENT_SERVICE_TYPES = [
  "agent_event",
  "AGENT_EVENT",
] as const;

export function getAgentEventService(
  runtime: RuntimeWithServiceGetter | null | undefined,
): AgentEventServiceLike | null {
  if (!runtime) return null;

  for (const serviceType of AGENT_EVENT_SERVICE_TYPES) {
    const service = runtime.getService(serviceType);
    if (
      service &&
      typeof (service as AgentEventServiceLike).subscribe === "function"
    ) {
      return service as AgentEventServiceLike;
    }
  }

  return null;
}

/** Publish only after a canonical client-visible message was committed. Metadata is
 * invalidation, not content or delivery permission; clients fetch owned history. */
export function publishConversationUpdate(
  runtime: Pick<IAgentRuntime, "agentId" | "getService" | "reportError">,
  conversationId: string,
  roomId: UUID,
  messageId: UUID,
): void {
  try {
    getAgentEventService(runtime)?.emit?.({
      runId: `conversation-delivery:${runtime.agentId}`,
      stream: "message",
      agentId: runtime.agentId,
      roomId,
      data: { type: "sent", channel: "client_chat", conversationId, messageId },
    });
  } catch (error) {
    // Neither an event observer nor its error reporter can undo a committed row
    // or prevent the independent WebSocket/notification delivery paths.
    try {
      runtime.reportError("conversation-event-publication", error, {
        conversationId,
        messageId,
      });
    } catch {
      /* Best-effort diagnostics only. */
    }
  }
}
