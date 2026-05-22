import { ElizaRuntimeApiClient } from "./api-client.ts";
import { createApiBridgeError, serializeError } from "./errors.ts";
import { RuntimeLogBuffer } from "./log-buffer.ts";
import type {
  AgentMessageParams,
  AgentMessageStreamCancelParams,
  AgentMessageStreamEvent,
  AgentMessageStreamParams,
  JsonValue,
  RuntimeLogEntry,
  RuntimeManagerEvent,
  RuntimeMethod,
  RuntimeResponsePayload,
  RuntimeStartParams,
  RuntimeState,
  RuntimeWorkerOutboundMessage,
  RuntimeWorkerRequestMessage,
  StreamEventKind,
} from "./protocol.ts";
import {
  FILE_REMOTE_PLUGIN_ID,
  GIT_REMOTE_PLUGIN_ID,
  MODEL_REMOTE_PLUGIN_ID,
  TERMINAL_REMOTE_PLUGIN_ID,
} from "./protocol.ts";
import { ElizaRuntimeManager } from "./runtime-manager.ts";
import { AgentStreamManager } from "./stream-manager.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type HostResponseMessage = {
  type: "host-response";
  requestId: number;
  success: boolean;
  payload?: JsonValue;
  error?: string;
};

type HostRequestMessage = {
  type: "host-request";
  requestId: number;
  method:
    | "invoke-remote-plugin"
    | "agent-manager-start"
    | "agent-manager-stop"
    | "agent-manager-restart"
    | "agent-manager-status"
    | "agent-manager-health"
    | "agent-manager-logs-tail"
    | "trace-session-start"
    | "trace-session-complete"
    | "trace-session-cancel"
    | "trace-session-error"
    | "trace-event-record";
  params?: JsonValue;
};

type PendingHostRequest = {
  method: string;
  unavailableMessage: string;
  resolve: (payload: JsonValue | undefined) => void;
  reject: (error: unknown) => void;
};

type TraceBinding = {
  sessionId: string;
  owned: boolean;
};

type JsonObject = { [key: string]: JsonValue };

const pendingHostRequests = new Map<number, PendingHostRequest>();
let nextHostRequestId = 1;
let hostRuntimeAdapterAvailable = false;
let hostRuntimeState: RuntimeState | null = null;
const streamTraceBindings = new Map<string, Promise<TraceBinding | null>>();

function post(message: RuntimeWorkerOutboundMessage): void {
  self.postMessage(message);
}

function postHost(message: HostRequestMessage): void {
  self.postMessage(message);
}

function isRuntimeMethod(value: string): value is RuntimeMethod {
  return (
    value === "runtime.start" ||
    value === "runtime.stop" ||
    value === "runtime.restart" ||
    value === "runtime.status" ||
    value === "runtime.health" ||
    value === "runtime.logs.tail" ||
    value === "api.discover" ||
    value === "api.status" ||
    value === "agent.list" ||
    value === "agent.get" ||
    value === "agent.message" ||
    value === "conversation.list" ||
    value === "conversation.get" ||
    value === "plugin.list" ||
    value === "memory.search" ||
    value === "config.get" ||
    value === "agent.message.stream" ||
    value === "agent.message.stream.cancel" ||
    value === "agent.message.stream.status" ||
    value === "fs.status" ||
    value === "fs.roots" ||
    value === "fs.stat" ||
    value === "fs.list" ||
    value === "fs.readText" ||
    value === "fs.search" ||
    value === "fs.writeText" ||
    value === "pty.status" ||
    value === "pty.session.create" ||
    value === "pty.session.list" ||
    value === "pty.session.get" ||
    value === "pty.session.write" ||
    value === "pty.session.resize" ||
    value === "pty.session.kill" ||
    value === "pty.session.output.tail" ||
    value === "pty.session.output.clear" ||
    value === "pty.command.run" ||
    value === "git.status" ||
    value === "git.repo.info" ||
    value === "git.branches" ||
    value === "git.remotes" ||
    value === "git.log" ||
    value === "git.diff" ||
    value === "git.show" ||
    value === "git.add" ||
    value === "git.restore" ||
    value === "git.checkout" ||
    value === "git.branch.create" ||
    value === "git.branch.delete" ||
    value === "git.commit" ||
    value === "git.fetch" ||
    value === "git.pull" ||
    value === "git.push" ||
    value === "git.operation.list" ||
    value === "git.operation.get" ||
    value === "git.command.run" ||
    value === "model.status" ||
    value === "model.hub" ||
    value === "model.catalog" ||
    value === "model.catalog.eliza1" ||
    value === "model.eliza1.tiers" ||
    value === "model.eliza1.voice" ||
    value === "model.hf.metadata" ||
    value === "model.providers" ||
    value === "model.hardware" ||
    value === "model.installed" ||
    value === "model.download.start" ||
    value === "model.download.cancel" ||
    value === "model.downloads" ||
    value === "model.active" ||
    value === "model.activate" ||
    value === "model.unload" ||
    value === "model.assignments" ||
    value === "model.assignment.set" ||
    value === "model.routing" ||
    value === "model.routing.set" ||
    value === "model.routing.useLocal" ||
    value === "model.routing.useCloud" ||
    value === "model.generate" ||
    value === "model.embedding" ||
    value === "model.capabilities"
  );
}

function isStreamEventKind(value: unknown): value is StreamEventKind {
  return (
    value === "started" ||
    value === "delta" ||
    value === "snapshot" ||
    value === "action" ||
    value === "error" ||
    value === "done" ||
    value === "cancelled"
  );
}

function isAgentMessageStreamEventPayload(
  value: unknown,
): value is AgentMessageStreamEvent {
  if (!isRecord(value)) return false;
  return typeof value.streamId === "string" && isStreamEventKind(value.kind);
}

function isHostResponse(value: unknown): value is HostResponseMessage {
  if (!isRecord(value)) return false;
  return (
    value.type === "host-response" &&
    typeof value.requestId === "number" &&
    typeof value.success === "boolean"
  );
}

function isInitMessage(value: unknown): value is { type: "init" } {
  return isRecord(value) && value.type === "init";
}

function completeHostRequest(message: HostResponseMessage): void {
  const pending = pendingHostRequests.get(message.requestId);
  if (!pending) return;
  pendingHostRequests.delete(message.requestId);
  if (message.success) {
    pending.resolve(message.payload);
    return;
  }
  pending.reject(
    createApiBridgeError({
      code: "CAPABILITY_UNAVAILABLE",
      message: pending.unavailableMessage,
      method: pending.method,
      details: message.error ?? "RemotePlugin request failed.",
    }),
  );
}

function parseRequest(value: unknown): RuntimeWorkerRequestMessage | null {
  if (!isRecord(value)) return null;
  if (value.type !== "request") return null;
  const requestId = value.requestId;
  const method = value.method;
  if (
    (typeof requestId !== "string" && typeof requestId !== "number") ||
    typeof method !== "string" ||
    !isRuntimeMethod(method)
  ) {
    throw new Error("Invalid runtime request.");
  }
  const params = value.params;
  return params === undefined
    ? { type: "request", requestId, method }
    : { type: "request", requestId, method, params: params as JsonValue };
}

function parseStartParams(params?: JsonValue): RuntimeStartParams | undefined {
  if (params === undefined) return undefined;
  if (!isRecord(params))
    throw new Error("runtime.start params must be an object.");
  const parsed: RuntimeStartParams = {};
  const cwd = params.cwd;
  const command = params.command;
  const apiBase = params.apiBase;
  if (cwd !== undefined) {
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new Error("runtime.start cwd must be a non-empty string.");
    }
    parsed.cwd = cwd;
  }
  if (apiBase !== undefined) {
    if (typeof apiBase !== "string" || apiBase.length === 0) {
      throw new Error("runtime.start apiBase must be a non-empty string.");
    }
    parsed.apiBase = apiBase;
  }
  if (command !== undefined) {
    if (typeof command === "string") {
      parsed.command = command;
    } else if (isStringArray(command)) {
      parsed.command = command;
    } else {
      throw new Error(
        "runtime.start command must be a string or string array.",
      );
    }
  }
  return parsed;
}

function isStringArray(value: JsonValue): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function stringParam(params: JsonValue | undefined, key: string): string {
  if (!isRecord(params)) {
    throw createApiBridgeError({
      code: "DECODE_FAILED",
      message: `${key} is required.`,
    });
  }
  const value = params[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createApiBridgeError({
      code: "DECODE_FAILED",
      message: `${key} must be a non-empty string.`,
    });
  }
  return value.trim();
}

function parseLogLimit(params?: JsonValue): number | undefined {
  if (params === undefined) return undefined;
  if (!isRecord(params))
    throw new Error("runtime.logs.tail params must be an object.");
  const limit = params.limit;
  if (limit === undefined) return undefined;
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new Error("runtime.logs.tail limit must be a finite number.");
  }
  return limit;
}

function parseDiscoverRefresh(params?: JsonValue): boolean {
  if (params === undefined) return true;
  if (!isRecord(params)) {
    throw createApiBridgeError({
      code: "DECODE_FAILED",
      message: "api.discover params must be an object.",
    });
  }
  const refresh = params.refresh;
  if (refresh === undefined) return true;
  if (typeof refresh !== "boolean") {
    throw createApiBridgeError({
      code: "DECODE_FAILED",
      message: "api.discover refresh must be a boolean.",
    });
  }
  return refresh;
}

function parseOptionalStringParam(
  params: Record<string, unknown>,
  key: string,
  methodName: string,
): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createApiBridgeError({
      code: "DECODE_FAILED",
      message: `${methodName} ${key} must be a non-empty string.`,
    });
  }
  return value.trim();
}

function parseAttachment(
  attachmentValue: unknown,
): NonNullable<AgentMessageParams["attachments"]>[number] | null {
  if (!isRecord(attachmentValue)) return null;
  const type = attachmentValue.type;
  if (type !== "file" && type !== "image" && type !== "audio") {
    throw createApiBridgeError({
      code: "DECODE_FAILED",
      message: "agent.message attachment type is invalid.",
    });
  }
  const path = attachmentValue.path;
  const url = attachmentValue.url;
  const mimeType = attachmentValue.mimeType;
  return {
    type,
    ...(typeof path === "string" ? { path } : {}),
    ...(typeof url === "string" ? { url } : {}),
    ...(typeof mimeType === "string" ? { mimeType } : {}),
  };
}

function parseAttachments(
  params: Record<string, unknown>,
): AgentMessageParams["attachments"] | undefined {
  if (!Array.isArray(params.attachments)) return undefined;
  const attachments: NonNullable<AgentMessageParams["attachments"]> = [];
  for (const attachmentValue of params.attachments) {
    const attachment = parseAttachment(attachmentValue);
    if (attachment !== null) attachments.push(attachment);
  }
  return attachments;
}

function parseAgentMessageParams(params?: JsonValue): AgentMessageParams {
  if (!isRecord(params)) {
    throw createApiBridgeError({
      code: "DECODE_FAILED",
      message: "agent.message params must be an object.",
    });
  }
  const text = params.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw createApiBridgeError({
      code: "DECODE_FAILED",
      message: "agent.message text must be a non-empty string.",
    });
  }
  const agentId = parseOptionalStringParam(params, "agentId", "agent.message");
  const conversationId = parseOptionalStringParam(
    params,
    "conversationId",
    "agent.message",
  );
  const attachments = parseAttachments(params);
  const parsed: AgentMessageParams = { text };
  if (agentId !== undefined) parsed.agentId = agentId;
  if (conversationId !== undefined) parsed.conversationId = conversationId;
  if (attachments !== undefined) parsed.attachments = attachments;
  return parsed;
}

function parseAgentMessageStreamParams(
  params?: JsonValue,
): AgentMessageStreamParams {
  const parsedMessage = parseAgentMessageParams(params);
  const parsed: AgentMessageStreamParams = {
    ...parsedMessage,
  };
  if (isRecord(params) && params.metadata !== undefined) {
    if (!isRecord(params.metadata)) {
      throw createApiBridgeError({
        code: "DECODE_FAILED",
        message: "agent.message.stream metadata must be an object.",
      });
    }
    parsed.metadata = params.metadata;
  }
  return parsed;
}

function parseStreamCancelParams(
  params?: JsonValue,
): AgentMessageStreamCancelParams {
  return { streamId: stringParam(params, "streamId") };
}

function parseMemorySearchParams(params?: JsonValue): {
  query: string;
  limit?: number;
  agentId?: string;
} {
  if (!isRecord(params)) {
    throw createApiBridgeError({
      code: "DECODE_FAILED",
      message: "memory.search params must be an object.",
    });
  }
  const query = params.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw createApiBridgeError({
      code: "DECODE_FAILED",
      message: "memory.search query must be a non-empty string.",
    });
  }
  const parsed: { query: string; limit?: number; agentId?: string } = {
    query: query.trim(),
  };
  if (params.limit !== undefined) {
    if (typeof params.limit !== "number" || !Number.isFinite(params.limit)) {
      throw createApiBridgeError({
        code: "DECODE_FAILED",
        message: "memory.search limit must be a finite number.",
      });
    }
    parsed.limit = params.limit;
  }
  if (params.agentId !== undefined) {
    if (
      typeof params.agentId !== "string" ||
      params.agentId.trim().length === 0
    ) {
      throw createApiBridgeError({
        code: "DECODE_FAILED",
        message: "memory.search agentId must be a non-empty string.",
      });
    }
    parsed.agentId = params.agentId.trim();
  }
  return parsed;
}

function currentApiBase(): string | null {
  return hostRuntimeAdapterAvailable
    ? (hostRuntimeState?.apiBase ?? null)
    : manager.status().apiBase;
}

function withRuntimeApiBase(params?: JsonValue): JsonValue | undefined {
  const apiBase = currentApiBase();
  if (!apiBase) return params;
  if (params === undefined) return { apiBase };
  if (!isRecord(params) || Array.isArray(params)) return params;
  const object = params as { [key: string]: JsonValue };
  if (typeof object.apiBase === "string" && object.apiBase.length > 0) {
    return params;
  }
  return { ...object, apiBase };
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && isRecord(value) && !Array.isArray(value);
}

function traceSessionIdFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string | null {
  const value = metadata?.traceSessionId;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function traceOpenViewFromMetadata(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return metadata?.traceOpenView === true || metadata?.openTraceView === true;
}

function traceSessionIdFromParams(params?: JsonValue): string | null {
  if (!isJsonObject(params)) return null;
  const value = params.traceSessionId;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function paramsWithoutTraceFields(params?: JsonValue): JsonValue | undefined {
  if (!isJsonObject(params)) return params;
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(params)) {
    if (key !== "traceSessionId" && key !== "traceOpenView") {
      output[key] = value;
    }
  }
  return output;
}

function streamTracePayload(event: AgentMessageStreamEvent): JsonValue {
  return {
    streamId: event.streamId,
    kind: event.kind,
    conversationId: event.conversationId ?? null,
    messageId: event.messageId ?? null,
    text: event.text ?? null,
    delta: event.delta ?? null,
    actionName: event.actionName ?? null,
    toolName: event.toolName ?? null,
    timestamp: event.timestamp,
    hasPayload: event.payload !== undefined,
    hasRaw: event.raw !== undefined,
  };
}

function requestHost(
  hostMethod: HostRequestMessage["method"],
  params: JsonValue | undefined,
  runtimeMethod: string,
  unavailableMessage: string,
): Promise<JsonValue | undefined> {
  const requestId = nextHostRequestId++;
  postHost({
    type: "host-request",
    requestId,
    method: hostMethod,
    ...(params === undefined ? {} : { params }),
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingHostRequests.delete(requestId);
      reject(
        createApiBridgeError({
          code: "CAPABILITY_UNAVAILABLE",
          message: unavailableMessage,
          method: runtimeMethod,
          details: "Timed out waiting for RemotePlugin response.",
        }),
      );
    }, 30_000);
    pendingHostRequests.set(requestId, {
      method: runtimeMethod,
      unavailableMessage,
      resolve: (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
  });
}

function requestTraceHost(
  hostMethod: HostRequestMessage["method"],
  params: JsonValue,
): Promise<JsonValue | undefined> {
  return requestHost(
    hostMethod,
    params,
    hostMethod,
    "Trace host is not available",
  );
}

function logTraceFailure(label: string, error: unknown): void {
  logBuffer.push(
    "system",
    `trace ${label} failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

function recordTraceEvent(params: JsonValue): void {
  void requestTraceHost("trace-event-record", params).catch((error) => {
    logTraceFailure("event record", error);
  });
}

function terminalTraceMethodForStream(
  kind: AgentMessageStreamEvent["kind"],
): HostRequestMessage["method"] | null {
  if (kind === "done") return "trace-session-complete";
  if (kind === "cancelled") return "trace-session-cancel";
  if (kind === "error") return "trace-session-error";
  return null;
}

function traceEventKindForStream(
  kind: AgentMessageStreamEvent["kind"],
): string {
  return `agent.message.stream.${kind}`;
}

function invokeRemotePlugin(
  remotePluginId: string,
  unavailableMessage: string,
  method: RuntimeMethod,
  params?: JsonValue,
): Promise<JsonValue | undefined> {
  return requestHost(
    "invoke-remote-plugin",
    {
      remotePluginId: remotePluginId,
      method,
      ...(params === undefined ? {} : { params }),
    },
    method,
    unavailableMessage,
  );
}

function startTraceForStream(
  result: {
    streamId: string;
    conversationId?: string;
    messageId?: string;
  },
  params: AgentMessageStreamParams,
): void {
  const existingTraceSessionId = traceSessionIdFromMetadata(params.metadata);
  const startParams: JsonObject = {
    title: "Agent message stream",
    source: "chat",
    streamId: result.streamId,
    openView: traceOpenViewFromMetadata(params.metadata),
    metadata: {
      text: params.text,
    },
  };
  if (result.conversationId !== undefined) {
    startParams.conversationId = result.conversationId;
  }
  if (result.messageId !== undefined) startParams.messageId = result.messageId;
  if (params.agentId !== undefined) startParams.agentId = params.agentId;
  const binding =
    existingTraceSessionId === null
      ? requestTraceHost("trace-session-start", startParams).then(
          (payload): TraceBinding | null => {
            if (!isJsonObject(payload)) return null;
            const sessionId = payload.id;
            if (typeof sessionId !== "string" || sessionId.length === 0) {
              return null;
            }
            return { sessionId, owned: true };
          },
        )
      : Promise.resolve({
          sessionId: existingTraceSessionId,
          owned: false,
        });
  streamTraceBindings.set(
    result.streamId,
    binding.catch((error) => {
      logTraceFailure("session start", error);
      return null;
    }),
  );
  void recordTraceForStreamEvent({
    streamId: result.streamId,
    kind: "started",
    conversationId: result.conversationId,
    messageId: result.messageId,
    text: params.text,
    timestamp: new Date().toISOString(),
  });
}

async function recordTraceForStreamEvent(
  event: AgentMessageStreamEvent,
): Promise<void> {
  const binding = await streamTraceBindings.get(event.streamId);
  if (!binding) return;
  const traceParams: JsonObject = {
    sessionId: binding.sessionId,
    kind: traceEventKindForStream(event.kind),
    title: event.kind,
    source: "chat",
    streamId: event.streamId,
    payload: streamTracePayload(event),
  };
  const text = event.text ?? event.delta;
  if (text !== undefined) traceParams.text = text;
  if (event.conversationId !== undefined) {
    traceParams.conversationId = event.conversationId;
  }
  if (event.messageId !== undefined) traceParams.messageId = event.messageId;
  if (event.toolName !== undefined) traceParams.toolName = event.toolName;
  recordTraceEvent(traceParams);
  const terminalMethod = terminalTraceMethodForStream(event.kind);
  if (terminalMethod === null) return;
  streamTraceBindings.delete(event.streamId);
  if (!binding.owned) return;
  const terminalParams: JsonObject = {
    sessionId: binding.sessionId,
  };
  if (event.kind === "cancelled") terminalParams.reason = "cancelled";
  if (event.kind === "error")
    terminalParams.error = event.text ?? "Stream failed";
  void requestTraceHost(terminalMethod, terminalParams).catch((error) => {
    logTraceFailure("session terminal", error);
  });
}

async function invokeTracedRemotePlugin(
  remotePluginId: string,
  unavailableMessage: string,
  method: RuntimeMethod,
  params?: JsonValue,
): Promise<JsonValue | undefined> {
  const traceSessionId = traceSessionIdFromParams(params);
  const forwardedParams = paramsWithoutTraceFields(params);
  if (traceSessionId === null) {
    return invokeRemotePlugin(
      remotePluginId,
      unavailableMessage,
      method,
      forwardedParams,
    );
  }
  recordTraceEvent({
    sessionId: traceSessionId,
    kind: "capability.invoke.started",
    source: "capability",
    capabilityId: remotePluginId,
    payload: {
      method,
      params: forwardedParams ?? null,
    },
  });
  try {
    const result = await invokeRemotePlugin(
      remotePluginId,
      unavailableMessage,
      method,
      forwardedParams,
    );
    recordTraceEvent({
      sessionId: traceSessionId,
      kind: "capability.invoke.completed",
      source: "capability",
      capabilityId: remotePluginId,
      payload: {
        method,
        result: result ?? null,
      },
    });
    return result;
  } catch (error) {
    recordTraceEvent({
      sessionId: traceSessionId,
      kind: "capability.invoke.error",
      source: "capability",
      capabilityId: remotePluginId,
      text: error instanceof Error ? error.message : String(error),
      payload: {
        method,
      },
    });
    throw error;
  }
}

function isHostAgentStatus(value: JsonValue | undefined): value is {
  state: "not_started" | "starting" | "running" | "stopped" | "error";
  port: number | null;
  startedAt: number | null;
  error: string | null;
} {
  if (!isRecord(value)) return false;
  const state = value.state;
  return (
    (state === "not_started" ||
      state === "starting" ||
      state === "running" ||
      state === "stopped" ||
      state === "error") &&
    (typeof value.port === "number" || value.port === null) &&
    (typeof value.startedAt === "number" || value.startedAt === null) &&
    (typeof value.error === "string" || value.error === null)
  );
}

function hostAgentStatusToRuntimeState(
  status: JsonValue | undefined,
): RuntimeState {
  if (!isHostAgentStatus(status)) {
    throw createApiBridgeError({
      code: "DECODE_FAILED",
      message: "AgentManager status response was not valid.",
      details: status,
    });
  }
  const mode = status.state === "not_started" ? "stopped" : status.state;
  return {
    mode,
    cwd: "AgentManager",
    command: ["AgentManager"],
    apiBase:
      typeof status.port === "number"
        ? `http://127.0.0.1:${status.port}`
        : null,
    pid: null,
    startedAt:
      typeof status.startedAt === "number"
        ? new Date(status.startedAt).toISOString()
        : null,
    stoppedAt: status.state === "stopped" ? new Date().toISOString() : null,
    error: status.error,
  };
}

async function requestHostRuntimeState(
  hostMethod:
    | "agent-manager-start"
    | "agent-manager-stop"
    | "agent-manager-restart"
    | "agent-manager-status",
  runtimeMethod: RuntimeMethod,
): Promise<RuntimeState> {
  const payload = await requestHost(
    hostMethod,
    undefined,
    runtimeMethod,
    "AgentManager runtime adapter is not available",
  );
  hostRuntimeState = hostAgentStatusToRuntimeState(payload);
  return hostRuntimeState;
}

async function ensureHostRuntimeState(): Promise<RuntimeState> {
  if (hostRuntimeState) return hostRuntimeState;
  return requestHostRuntimeState("agent-manager-status", "runtime.status");
}

function hostLogTailToEntries(
  payload: JsonValue | undefined,
): RuntimeLogEntry[] {
  if (!isRecord(payload)) {
    throw createApiBridgeError({
      code: "DECODE_FAILED",
      message: "AgentManager log response was not valid.",
      details: payload,
    });
  }
  const text = payload.text;
  if (typeof text !== "string") {
    throw createApiBridgeError({
      code: "DECODE_FAILED",
      message: "AgentManager log response did not include text.",
      details: payload,
    });
  }
  const timestamp = new Date().toISOString();
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => ({ timestamp, stream: "system", line }));
}

const logBuffer = new RuntimeLogBuffer();
const manager = new ElizaRuntimeManager({
  logBuffer,
  onEvent: (event: RuntimeManagerEvent) => {
    post({
      type: "event",
      name: event.name,
      payload: event.payload,
    });
  },
});
const apiClient = new ElizaRuntimeApiClient({
  getApiBase: currentApiBase,
  getAuthToken: () =>
    process.env.ELIZA_RUNTIME_API_TOKEN ?? process.env.ELIZA_API_TOKEN ?? null,
});
const streamManager = new AgentStreamManager({
  getApiBase: currentApiBase,
  getAuthToken: () =>
    process.env.ELIZA_RUNTIME_API_TOKEN ?? process.env.ELIZA_API_TOKEN ?? null,
  emit: (name, payload) => {
    post({
      type: "event",
      name: name as RuntimeManagerEvent["name"],
      payload: payload as RuntimeManagerEvent["payload"],
    });
    if (isAgentMessageStreamEventPayload(payload)) {
      void recordTraceForStreamEvent(payload);
    }
  },
  log: (line) => {
    logBuffer.push("system", line);
  },
});

const FILE_METHODS = new Set<RuntimeMethod>([
  "fs.status",
  "fs.roots",
  "fs.stat",
  "fs.list",
  "fs.readText",
  "fs.search",
  "fs.writeText",
]);

const PTY_METHODS = new Set<RuntimeMethod>([
  "pty.status",
  "pty.session.create",
  "pty.session.list",
  "pty.session.get",
  "pty.session.write",
  "pty.session.resize",
  "pty.session.kill",
  "pty.session.output.tail",
  "pty.session.output.clear",
  "pty.command.run",
]);

const GIT_METHODS = new Set<RuntimeMethod>([
  "git.status",
  "git.repo.info",
  "git.branches",
  "git.remotes",
  "git.log",
  "git.diff",
  "git.show",
  "git.add",
  "git.restore",
  "git.checkout",
  "git.branch.create",
  "git.branch.delete",
  "git.commit",
  "git.fetch",
  "git.pull",
  "git.push",
  "git.operation.list",
  "git.operation.get",
  "git.command.run",
]);

const MODEL_METHODS = new Set<RuntimeMethod>([
  "model.status",
  "model.hub",
  "model.catalog",
  "model.catalog.eliza1",
  "model.eliza1.tiers",
  "model.eliza1.voice",
  "model.hf.metadata",
  "model.providers",
  "model.hardware",
  "model.installed",
  "model.download.start",
  "model.download.cancel",
  "model.downloads",
  "model.active",
  "model.activate",
  "model.unload",
  "model.assignments",
  "model.assignment.set",
  "model.routing",
  "model.routing.set",
  "model.routing.useLocal",
  "model.routing.useCloud",
  "model.generate",
  "model.embedding",
  "model.capabilities",
]);

const API_METHODS_REQUIRING_RUNTIME_STATE = new Set<RuntimeMethod>([
  "api.discover",
  "api.status",
  "agent.list",
  "agent.get",
  "agent.message",
  "conversation.list",
  "conversation.get",
  "plugin.list",
  "memory.search",
  "config.get",
  "agent.message.stream",
]);

type RemotePluginRoute = {
  remotePluginId: string;
  unavailableMessage: string;
  params?: JsonValue;
};

function remotePluginRouteFor(
  request: RuntimeWorkerRequestMessage,
): RemotePluginRoute | null {
  if (FILE_METHODS.has(request.method)) {
    return {
      remotePluginId: FILE_REMOTE_PLUGIN_ID,
      unavailableMessage: "File RemotePlugin eliza.fs is not available",
      params: request.params,
    };
  }
  if (PTY_METHODS.has(request.method)) {
    return {
      remotePluginId: TERMINAL_REMOTE_PLUGIN_ID,
      unavailableMessage: "Terminal RemotePlugin eliza.pty is not available",
      params: request.params,
    };
  }
  if (GIT_METHODS.has(request.method)) {
    return {
      remotePluginId: GIT_REMOTE_PLUGIN_ID,
      unavailableMessage: "Git RemotePlugin eliza.git is not available",
      params: request.params,
    };
  }
  if (!MODEL_METHODS.has(request.method)) return null;
  return {
    remotePluginId: MODEL_REMOTE_PLUGIN_ID,
    unavailableMessage: "Model RemotePlugin eliza.local-model is not available",
    params: withRuntimeApiBase(request.params),
  };
}

async function dispatchRuntimeRequest(
  request: RuntimeWorkerRequestMessage,
): Promise<RuntimeResponsePayload | null> {
  switch (request.method) {
    case "runtime.start":
      if (hostRuntimeAdapterAvailable) {
        return requestHostRuntimeState("agent-manager-start", request.method);
      }
      return manager.start(parseStartParams(request.params));
    case "runtime.stop":
      if (hostRuntimeAdapterAvailable) {
        return requestHostRuntimeState("agent-manager-stop", request.method);
      }
      return manager.stop();
    case "runtime.restart":
      if (hostRuntimeAdapterAvailable) {
        return requestHostRuntimeState("agent-manager-restart", request.method);
      }
      return manager.restart(parseStartParams(request.params));
    case "runtime.status":
      if (hostRuntimeAdapterAvailable) {
        return requestHostRuntimeState("agent-manager-status", request.method);
      }
      return manager.status();
    case "runtime.health":
      if (hostRuntimeAdapterAvailable) {
        await ensureHostRuntimeState();
        return requestHost(
          "agent-manager-health",
          undefined,
          request.method,
          "AgentManager runtime adapter is not available",
        );
      }
      return manager.health();
    case "runtime.logs.tail":
      if (hostRuntimeAdapterAvailable) {
        const limit = parseLogLimit(request.params);
        const payload = await requestHost(
          "agent-manager-logs-tail",
          limit === undefined
            ? undefined
            : { maxBytes: Math.max(1, limit * 2048) },
          request.method,
          "AgentManager runtime adapter is not available",
        );
        return hostLogTailToEntries(payload).slice(-(limit ?? 100));
      }
      return manager.logsTail(parseLogLimit(request.params));
    default:
      return null;
  }
}

async function dispatchApiRequest(
  request: RuntimeWorkerRequestMessage,
): Promise<RuntimeResponsePayload | null> {
  if (
    hostRuntimeAdapterAvailable &&
    API_METHODS_REQUIRING_RUNTIME_STATE.has(request.method)
  ) {
    await ensureHostRuntimeState();
  }
  switch (request.method) {
    case "api.discover":
      return apiClient.discover(parseDiscoverRefresh(request.params));
    case "api.status":
      return apiClient.status();
    case "agent.list":
      return apiClient.listAgents();
    case "agent.get":
      return apiClient.getAgent(stringParam(request.params, "agentId"));
    case "agent.message":
      return apiClient.sendMessage(parseAgentMessageParams(request.params));
    case "conversation.list":
      return apiClient.listConversations();
    case "conversation.get":
      return apiClient.getConversation(
        stringParam(request.params, "conversationId"),
      );
    case "plugin.list":
      return apiClient.listPlugins();
    case "memory.search":
      return apiClient.searchMemory(parseMemorySearchParams(request.params));
    case "config.get":
      return apiClient.getConfig();
    case "agent.message.stream":
      return startAgentMessageStream(request.params);
    case "agent.message.stream.cancel":
      return streamManager.cancelStream(
        parseStreamCancelParams(request.params),
      );
    case "agent.message.stream.status":
      return streamManager.getStreamStatus(
        stringParam(request.params, "streamId"),
      );
    default:
      return null;
  }
}

async function startAgentMessageStream(
  paramsValue: JsonValue | undefined,
): Promise<RuntimeResponsePayload> {
  const params = parseAgentMessageStreamParams(paramsValue);
  const result = await streamManager.startMessageStream(params);
  startTraceForStream(result, params);
  return result;
}

async function dispatch(
  request: RuntimeWorkerRequestMessage,
): Promise<RuntimeResponsePayload> {
  const runtimeResponse = await dispatchRuntimeRequest(request);
  if (runtimeResponse !== null) return runtimeResponse;
  const apiResponse = await dispatchApiRequest(request);
  if (apiResponse !== null) return apiResponse;
  const route = remotePluginRouteFor(request);
  if (route !== null) {
    return invokeTracedRemotePlugin(
      route.remotePluginId,
      route.unavailableMessage,
      request.method,
      route.params,
    );
  }
  throw new Error(`Unsupported runtime method: ${request.method}`);
}

self.addEventListener("message", (event) => {
  void (async () => {
    let request: RuntimeWorkerRequestMessage | null = null;
    try {
      if (isInitMessage(event.data)) {
        hostRuntimeAdapterAvailable = true;
        void requestHostRuntimeState(
          "agent-manager-status",
          "runtime.status",
        ).catch((error) => {
          logBuffer.push(
            "system",
            `AgentManager adapter status probe failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
        return;
      }
      if (isHostResponse(event.data)) {
        completeHostRequest(event.data);
        return;
      }
      request = parseRequest(event.data);
      if (request === null) return;
      const payload = await dispatch(request);
      post({
        type: "response",
        requestId: request.requestId,
        success: true,
        payload,
      });
    } catch (error) {
      if (request === null) return;
      post({
        type: "response",
        requestId: request.requestId,
        success: false,
        error: serializeError(error),
      });
    }
  })();
});

post({ type: "ready" });
