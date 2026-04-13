import type { UUID } from "@elizaos/core";

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
