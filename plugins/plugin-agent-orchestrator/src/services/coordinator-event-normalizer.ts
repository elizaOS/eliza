import type { SessionEventName } from "./pty-types.js";

export type CoordinatorEventSource =
  | "pty_manager"
  | "adapter_fast_path"
  | "session_ready_forward"
  | "hook"
  | "unknown";

export interface CoordinatorSessionSnapshot {
  id: string;
  type?: string;
  status?: string;
}

interface CoordinatorEventBase<TName extends SessionEventName> {
  sessionId: string;
  name: TName;
  source: CoordinatorEventSource;
  timestamp: number;
  rawData: unknown;
  session?: CoordinatorSessionSnapshot;
}

export interface CoordinatorReadyEvent extends CoordinatorEventBase<"ready"> {}

export interface CoordinatorBlockedEvent
  extends CoordinatorEventBase<"blocked"> {
  promptText: string;
  promptType?: string;
  promptInfo?: Record<string, unknown>;
  autoResponded: boolean;
}

export interface CoordinatorLoginRequiredEvent
  extends CoordinatorEventBase<"login_required"> {
  instructions?: string;
  url?: string;
  deviceCode?: string;
  method?: string;
  promptSnippet?: string;
}

export interface CoordinatorTaskCompleteEvent
  extends CoordinatorEventBase<"task_complete"> {
  response: string;
}

export interface CoordinatorToolRunningEvent
  extends CoordinatorEventBase<"tool_running"> {
  toolName?: string;
  description?: string;
}

export interface CoordinatorStoppedEvent
  extends CoordinatorEventBase<"stopped"> {
  reason?: string;
}

export interface CoordinatorErrorEvent extends CoordinatorEventBase<"error"> {
  message: string;
}

export interface CoordinatorMessageEvent
  extends CoordinatorEventBase<"message"> {
  content?: string;
}

export type CoordinatorNormalizedEvent =
  | CoordinatorReadyEvent
  | CoordinatorBlockedEvent
  | CoordinatorLoginRequiredEvent
  | CoordinatorTaskCompleteEvent
  | CoordinatorToolRunningEvent
  | CoordinatorStoppedEvent
  | CoordinatorErrorEvent
  | CoordinatorMessageEvent;

function normalizeSource(data: unknown): CoordinatorEventSource {
  const source =
    typeof (data as { source?: unknown } | undefined)?.source === "string"
      ? ((data as { source: string }).source as string)
      : "";
  switch (source) {
    case "pty_manager":
    case "adapter_fast_path":
    case "session_ready_forward":
    case "hook":
      return source;
    default:
      return "unknown";
  }
}

function normalizeSessionSnapshot(
  data: unknown,
): CoordinatorSessionSnapshot | undefined {
  const session = (data as { session?: unknown } | undefined)?.session;
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return undefined;
  }
  const record = session as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : undefined;
  if (!id) return undefined;
  return {
    id,
    ...(typeof record.type === "string" ? { type: record.type } : {}),
    ...(typeof record.status === "string" ? { status: record.status } : {}),
  };
}

export function normalizeCoordinatorEvent(
  sessionId: string,
  event: string,
  data: unknown,
): CoordinatorNormalizedEvent | null {
  const timestamp =
    typeof (data as { timestamp?: unknown } | undefined)?.timestamp === "number"
      ? ((data as { timestamp: number }).timestamp as number)
      : Date.now();
  const source = normalizeSource(data);
  const session = normalizeSessionSnapshot(data);

  switch (event as SessionEventName) {
    case "ready":
      return {
        sessionId,
        name: "ready",
        source,
        timestamp,
        rawData: data,
        ...(session ? { session } : {}),
      };
    case "blocked": {
      const promptInfo = (data as { promptInfo?: unknown } | undefined)
        ?.promptInfo;
      const promptRecord =
        promptInfo &&
        typeof promptInfo === "object" &&
        !Array.isArray(promptInfo)
          ? (promptInfo as Record<string, unknown>)
          : undefined;
      const promptText =
        (typeof promptRecord?.prompt === "string" && promptRecord.prompt) ||
        (typeof promptRecord?.instructions === "string" &&
          promptRecord.instructions) ||
        "";
      return {
        sessionId,
        name: "blocked",
        source,
        timestamp,
        rawData: data,
        ...(session ? { session } : {}),
        promptText,
        ...(typeof promptRecord?.type === "string"
          ? { promptType: promptRecord.type }
          : {}),
        ...(promptRecord ? { promptInfo: promptRecord } : {}),
        autoResponded:
          (data as { autoResponded?: unknown } | undefined)?.autoResponded ===
          true,
      };
    }
    case "login_required":
      return {
        sessionId,
        name: "login_required",
        source,
        timestamp,
        rawData: data,
        ...(session ? { session } : {}),
        ...(typeof (data as { instructions?: unknown } | undefined)
          ?.instructions === "string"
          ? {
              instructions: (data as { instructions: string }).instructions,
            }
          : {}),
        ...(typeof (data as { url?: unknown } | undefined)?.url === "string"
          ? {
              url: (data as { url: string }).url,
            }
          : {}),
        ...(typeof (data as { deviceCode?: unknown } | undefined)
          ?.deviceCode === "string"
          ? {
              deviceCode: (data as { deviceCode: string }).deviceCode,
            }
          : {}),
        ...(typeof (data as { method?: unknown } | undefined)?.method ===
        "string"
          ? {
              method: (data as { method: string }).method,
            }
          : {}),
        ...(typeof (data as { promptSnippet?: unknown } | undefined)
          ?.promptSnippet === "string"
          ? {
              promptSnippet: (data as { promptSnippet: string }).promptSnippet,
            }
          : {}),
      };
    case "task_complete":
      return {
        sessionId,
        name: "task_complete",
        source,
        timestamp,
        rawData: data,
        ...(session ? { session } : {}),
        response:
          typeof (data as { response?: unknown } | undefined)?.response ===
          "string"
            ? (data as { response: string }).response
            : "",
      };
    case "tool_running":
      return {
        sessionId,
        name: "tool_running",
        source,
        timestamp,
        rawData: data,
        ...(session ? { session } : {}),
        ...(typeof (data as { toolName?: unknown } | undefined)?.toolName ===
        "string"
          ? { toolName: (data as { toolName: string }).toolName }
          : {}),
        ...(typeof (data as { description?: unknown } | undefined)
          ?.description === "string"
          ? { description: (data as { description: string }).description }
          : {}),
      };
    case "stopped":
      return {
        sessionId,
        name: "stopped",
        source,
        timestamp,
        rawData: data,
        ...(session ? { session } : {}),
        ...(typeof (data as { reason?: unknown } | undefined)?.reason ===
        "string"
          ? { reason: (data as { reason: string }).reason }
          : {}),
      };
    case "error":
      return {
        sessionId,
        name: "error",
        source,
        timestamp,
        rawData: data,
        ...(session ? { session } : {}),
        message:
          typeof (data as { message?: unknown } | undefined)?.message ===
          "string"
            ? (data as { message: string }).message
            : "unknown error",
      };
    case "message":
      return {
        sessionId,
        name: "message",
        source,
        timestamp,
        rawData: data,
        ...(session ? { session } : {}),
        ...(typeof (data as { content?: unknown } | undefined)?.content ===
        "string"
          ? { content: (data as { content: string }).content }
          : {}),
      };
    default:
      return null;
  }
}
