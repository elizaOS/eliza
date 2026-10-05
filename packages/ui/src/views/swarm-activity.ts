/** Projects coordinator events into typed activity rows for host chat renderers. */
import type {
  SwarmActivityEnvelope,
  SwarmActivityPlanEntry,
  SwarmActivityStatus,
  SwarmActivityTool,
  SwarmEvent,
} from "@elizaos/core";

export type { SwarmEvent } from "@elizaos/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStr(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const LIFECYCLE_STATUS: Record<string, SwarmActivityStatus> = {
  ready: "idle",
  task_registered: "running",
  reconnected: "running",
  task_complete: "success",
  stopped: "idle",
  error: "failure",
  blocked: "waiting",
  login_required: "waiting",
  escalation: "waiting",
};

const TOOL_STATUS: Record<string, SwarmActivityStatus> = {
  pending: "running",
  running: "running",
  in_progress: "running",
  completed: "success",
  failed: "failure",
  error: "failure",
  cancelled: "idle",
};

/**
 * Narrow one raw {@link SwarmEvent} to the typed inline-activity envelope, or
 * `null` when the event carries nothing renderable (e.g. a `plan` update with
 * no entries, a `message` with empty text). Pure and dependency-free so it runs
 * identically on the server (tests) and in the browser widget layer.
 */
export function toSwarmActivity(
  event: SwarmEvent,
): SwarmActivityEnvelope | null {
  const data = isRecord(event.data) ? event.data : {};
  const base = {
    sessionId: event.sessionId,
    seq: event.seq ?? event.timestamp,
    timestamp: event.timestamp,
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.parentSessionId
      ? { parentSessionId: event.parentSessionId }
      : {}),
  };

  switch (event.type) {
    case "message": {
      const text = readStr(data, "text");
      return text ? { ...base, kind: "message", text } : null;
    }
    case "reasoning": {
      const text = readStr(data, "text");
      return text ? { ...base, kind: "reasoning", text } : null;
    }
    case "plan": {
      const raw = data.entries;
      if (!Array.isArray(raw)) return null;
      const entries: SwarmActivityPlanEntry[] = raw
        .filter(isRecord)
        .map((entry) => ({
          content: readStr(entry, "content") ?? "",
          status: readStr(entry, "status") ?? "pending",
          ...(readStr(entry, "priority")
            ? { priority: readStr(entry, "priority") }
            : {}),
        }))
        .filter((entry) => entry.content.length > 0);
      return entries.length > 0 ? { ...base, kind: "plan", entries } : null;
    }
    case "tool_running": {
      const call = isRecord(data.toolCall) ? data.toolCall : data;
      const rawStatus = readStr(call, "status") ?? "running";
      const tool: SwarmActivityTool = {
        status: TOOL_STATUS[rawStatus] ?? "running",
        ...(readStr(call, "id") ? { id: readStr(call, "id") } : {}),
        ...(readStr(call, "title") ? { title: readStr(call, "title") } : {}),
        ...(readStr(call, "kind") ? { kind: readStr(call, "kind") } : {}),
        ...(readStr(call, "output") ? { output: readStr(call, "output") } : {}),
        ...(isRecord(call.rawInput) ? { rawInput: call.rawInput } : {}),
        ...(Array.isArray(call.locations)
          ? {
              locations: call.locations.filter(isRecord) as Array<{
                path?: string;
                line?: number;
              }>,
            }
          : {}),
      };
      return { ...base, kind: "tool", tool };
    }
    default: {
      const status = LIFECYCLE_STATUS[event.type];
      if (!status) return null;
      return {
        ...base,
        kind: "lifecycle",
        event: event.type,
        status,
        ...(readStr(data, "label") ? { label: readStr(data, "label") } : {}),
        ...((readStr(data, "text") ?? readStr(data, "message"))
          ? { text: readStr(data, "text") ?? readStr(data, "message") }
          : {}),
      };
    }
  }
}
