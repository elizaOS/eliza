/** Implements Electrobun runtime remote stream manager ts boundaries for desktop app-core. */
import { createApiBridgeError, isApiBridgeError } from "./errors.ts";
import type {
  AgentMessageStreamCancelParams,
  AgentMessageStreamEvent,
  AgentMessageStreamParams,
  AgentMessageStreamStartResult,
  AgentMessageStreamStatus,
  ApiDiscoveryResult,
  StreamEventKind,
  StreamId,
  StreamingRouteStatus,
} from "./protocol.ts";
import {
  discoverRuntimeApiRoutes,
  findAvailableStreamingRoute,
} from "./route-discovery.ts";
import { type ParsedSSEEvent, SSEParser } from "./sse-parser.ts";

type AgentStreamManagerOptions = {
  getApiBase: () => string | null;
  getAuthToken?: () => string | null;
  emit: (name: string, payload: unknown) => void;
  log?: (line: string) => void;
};

type StreamRecord = {
  controller: AbortController;
  status: AgentMessageStreamStatus;
  conversationId?: string;
  messageId?: string;
  text: string;
  finished: boolean;
  accumulatedText: string;
};

type StreamRoute = {
  name: string;
  method: "GET" | "POST";
  path: string;
};

type JsonObject = Record<string, unknown>;

const REAL_CONVERSATION_STREAM_ROUTE = {
  name: "stream.conversationMessage",
  method: "POST",
  path: "/api/conversations/:conversationId/messages/stream",
} as const;
const STREAM_HISTORY_LIMIT = 100;
const STREAM_REQUEST_TIMEOUT_MS = 5000;

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function joinApiPath(apiBase: string, path: string): string {
  const base = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
  return `${base}${path}`;
}

function errorMessage(error: Error): string {
  return error.message.length > 0 ? error.message : error.name;
}

function resolveAuthToken(options: AgentStreamManagerOptions): string | null {
  const configured = options.getAuthToken?.();
  if (
    configured !== undefined &&
    configured !== null &&
    configured.trim().length > 0
  ) {
    return configured.trim();
  }
  const envToken =
    process.env.ELIZA_RUNTIME_API_TOKEN ?? process.env.ELIZA_API_TOKEN ?? null;
  return envToken !== null && envToken.trim().length > 0
    ? envToken.trim()
    : null;
}

function titleFromText(text: string): string {
  const title = text
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 5)
    .join(" ");
  return title.length > 0 ? title : "New Chat";
}

function eventNameForKind(kind: StreamEventKind): string {
  return `agent.message.stream.${kind}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function streamEvent(
  record: StreamRecord,
  kind: StreamEventKind,
  input: Omit<AgentMessageStreamEvent, "streamId" | "kind" | "timestamp"> = {},
): AgentMessageStreamEvent {
  return {
    streamId: record.status.streamId,
    kind,
    ...(record.conversationId === undefined
      ? {}
      : { conversationId: record.conversationId }),
    ...(record.messageId === undefined ? {} : { messageId: record.messageId }),
    ...input,
    timestamp: new Date().toISOString(),
  };
}

function idFromResponse(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = asString(value.id) ?? asString(value.conversationId);
  if (direct !== undefined) return direct;
  const conversation = value.conversation;
  return isRecord(conversation)
    ? (asString(conversation.id) ?? asString(conversation.conversationId))
    : undefined;
}

function textFromPayload(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return (
    asString(value.text) ??
    asString(value.fullText) ??
    asString(value.content) ??
    asString(value.message) ??
    asString(value.callbackText)
  );
}

function actionNameFromPayload(value: JsonObject): string | undefined {
  const action = value.action;
  if (typeof action === "string" && action.trim().length > 0)
    return action.trim();
  if (isRecord(action)) {
    const name = asString(action.name) ?? asString(action.actionName);
    if (name !== undefined) return name;
  }
  return asString(value.actionName) ?? asString(value.callback);
}

function toolNameFromPayload(value: JsonObject): string | undefined {
  const tool = value.tool;
  if (typeof tool === "string" && tool.trim().length > 0) return tool.trim();
  if (isRecord(tool)) {
    const name = asString(tool.name) ?? asString(tool.toolName);
    if (name !== undefined) return name;
  }
  return asString(value.toolName);
}

function parseJsonPayload(data: string): unknown {
  return JSON.parse(data) as unknown;
}

function contentTypeIsEventStream(contentType: string | null): boolean {
  return contentType?.toLowerCase().includes("text/event-stream") === true;
}

function contentTypeIsJson(contentType: string | null): boolean {
  return contentType?.toLowerCase().includes("json") === true;
}

function normalizeNonRecordPayload(
  record: StreamRecord,
  payload: unknown,
): AgentMessageStreamEvent[] {
  if (typeof payload === "string" && payload.trim().length > 0) {
    return [streamEvent(record, "snapshot", { text: payload, raw: payload })];
  }
  return [streamEvent(record, "snapshot", { raw: payload })];
}

function normalizeDonePayload(
  record: StreamRecord,
  payload: JsonObject,
  firstChoice: unknown,
  type: string | undefined,
): AgentMessageStreamEvent[] | null {
  const finishReason = isRecord(firstChoice)
    ? asString(firstChoice.finish_reason)
    : undefined;
  if (
    type !== "done" &&
    payload.done !== true &&
    payload.completed !== true &&
    finishReason === undefined &&
    type !== "message_stop"
  ) {
    return null;
  }
  const text = textFromPayload(payload);
  if (text !== undefined) record.accumulatedText = text;
  return [
    streamEvent(record, "done", {
      ...(text === undefined ? {} : { text }),
      payload,
      raw: payload,
    }),
  ];
}

function normalizeErrorPayload(
  record: StreamRecord,
  payload: JsonObject,
  type: string | undefined,
): AgentMessageStreamEvent[] | null {
  if (type !== "error" && payload.error === undefined) return null;
  const message =
    isRecord(payload.error) && asString(payload.error.message)
      ? asString(payload.error.message)
      : (asString(payload.message) ?? "Runtime stream error");
  return [
    streamEvent(record, "error", {
      text: message,
      payload,
      raw: payload,
    }),
  ];
}

function normalizeChoiceDelta(
  record: StreamRecord,
  payload: JsonObject,
  firstChoice: unknown,
): AgentMessageStreamEvent[] | null {
  if (!isRecord(firstChoice) || !isRecord(firstChoice.delta)) return null;
  const content = asString(firstChoice.delta.content);
  if (content === undefined) return null;
  record.accumulatedText += content;
  return [
    streamEvent(record, "delta", {
      delta: content,
      text: record.accumulatedText,
      payload,
      raw: payload,
    }),
  ];
}

function normalizeObjectDelta(
  record: StreamRecord,
  payload: JsonObject,
): AgentMessageStreamEvent[] | null {
  if (!isRecord(payload.delta)) return null;
  const text = asString(payload.delta.text);
  if (text === undefined) return null;
  record.accumulatedText += text;
  return [
    streamEvent(record, "delta", {
      delta: text,
      text: record.accumulatedText,
      payload,
      raw: payload,
    }),
  ];
}

function normalizeActionPayload(
  record: StreamRecord,
  payload: JsonObject,
): AgentMessageStreamEvent[] | null {
  const actionName = actionNameFromPayload(payload);
  const toolName = toolNameFromPayload(payload);
  if (actionName === undefined && toolName === undefined) return null;
  return [
    streamEvent(record, "action", {
      ...(actionName === undefined ? {} : { actionName }),
      ...(toolName === undefined ? {} : { toolName }),
      text: textFromPayload(payload),
      payload,
      raw: payload,
    }),
  ];
}

function normalizeExplicitDelta(
  record: StreamRecord,
  payload: JsonObject,
): AgentMessageStreamEvent[] | null {
  const explicitDelta =
    asString(payload.token) ??
    asString(payload.delta) ??
    asString(payload.content_delta) ??
    asString(payload.text_delta) ??
    asString(payload.chunk);
  if (explicitDelta === undefined) return null;
  const fullText = asString(payload.fullText);
  record.accumulatedText =
    fullText ?? `${record.accumulatedText}${explicitDelta}`;
  return [
    streamEvent(record, "delta", {
      delta: explicitDelta,
      text: record.accumulatedText,
      payload,
      raw: payload,
    }),
  ];
}

function normalizeTokenPayload(
  record: StreamRecord,
  payload: JsonObject,
  type: string | undefined,
): AgentMessageStreamEvent[] | null {
  if (type !== "token") return null;
  const chunk = asString(payload.text);
  const fullText = asString(payload.fullText);
  if (chunk !== undefined && chunk.length > 0) {
    record.accumulatedText = fullText ?? `${record.accumulatedText}${chunk}`;
    return [
      streamEvent(record, "delta", {
        delta: chunk,
        text: record.accumulatedText,
        payload,
        raw: payload,
      }),
    ];
  }
  if (fullText === undefined) return null;
  record.accumulatedText = fullText;
  return [
    streamEvent(record, "snapshot", {
      text: fullText,
      payload,
      raw: payload,
    }),
  ];
}

function normalizeSnapshotPayload(
  record: StreamRecord,
  payload: JsonObject,
): AgentMessageStreamEvent[] | null {
  const snapshotText = textFromPayload(payload);
  if (snapshotText === undefined) return null;
  record.accumulatedText = snapshotText;
  return [
    streamEvent(record, "snapshot", {
      text: snapshotText,
      payload,
      raw: payload,
    }),
  ];
}

function isStructuralStreamEvent(type: string | undefined): boolean {
  return (
    type === "message_start" ||
    type === "content_block_start" ||
    type === "content_block_stop" ||
    type === "message_delta"
  );
}

export function normalizeStreamEvent(
  record: StreamRecord,
  payload: unknown,
): AgentMessageStreamEvent[] {
  if (payload === "[DONE]")
    return [streamEvent(record, "done", { raw: payload })];
  if (!isRecord(payload)) return normalizeNonRecordPayload(record, payload);

  const type = asString(payload.type);
  const firstChoice = Array.isArray(payload.choices)
    ? payload.choices[0]
    : undefined;
  const normalized =
    normalizeDonePayload(record, payload, firstChoice, type) ??
    normalizeErrorPayload(record, payload, type) ??
    normalizeChoiceDelta(record, payload, firstChoice) ??
    normalizeObjectDelta(record, payload) ??
    normalizeActionPayload(record, payload) ??
    normalizeExplicitDelta(record, payload) ??
    normalizeTokenPayload(record, payload, type) ??
    normalizeSnapshotPayload(record, payload);
  if (normalized !== null) return normalized;
  if (isStructuralStreamEvent(type))
    return [streamEvent(record, "snapshot", { payload, raw: payload })];

  return [streamEvent(record, "snapshot", { raw: payload })];
}

export class AgentStreamManager {
  private readonly active = new Map<StreamId, StreamRecord>();
  private readonly history = new Map<StreamId, AgentMessageStreamStatus>();
  private readonly options: AgentStreamManagerOptions;
  private discovery: ApiDiscoveryResult | null = null;

  constructor(options: AgentStreamManagerOptions) {
    this.options = options;
  }

  async startMessageStream(
    params: AgentMessageStreamParams,
  ): Promise<AgentMessageStreamStartResult> {
    const text = params.text.trim();
    if (text.length === 0) {
      throw createApiBridgeError({
        code: "DECODE_FAILED",
        message: "agent.message.stream requires non-empty text.",
        method: "POST",
      });
    }

    const apiBase = this.requireApiBase();
    const conversationId =
      params.conversationId ?? (await this.createConversation(apiBase, params));
    const streamId = crypto.randomUUID();
    const record: StreamRecord = {
      controller: new AbortController(),
      status: {
        streamId,
        active: true,
        startedAt: new Date().toISOString(),
      },
      conversationId,
      text,
      finished: false,
      accumulatedText: "",
    };
    this.active.set(streamId, record);
    this.emit(record, "started", { text });
    void this.runStream(apiBase, record, params);
    return { ok: true, streamId, conversationId };
  }

  async cancelStream(
    params: AgentMessageStreamCancelParams,
  ): Promise<AgentMessageStreamStatus> {
    const record = this.active.get(params.streamId);
    if (record === undefined) {
      const status = this.history.get(params.streamId);
      if (status !== undefined) return status;
      throw createApiBridgeError({
        code: "ROUTE_UNAVAILABLE",
        message: `No active stream exists for ${params.streamId}.`,
      });
    }
    record.controller.abort("cancelled");
    this.finish(record, "cancelled");
    this.emit(record, "cancelled");
    return record.status;
  }

  getStreamStatus(streamId: StreamId): AgentMessageStreamStatus | null {
    return (
      this.active.get(streamId)?.status ?? this.history.get(streamId) ?? null
    );
  }

  private async runStream(
    apiBase: string,
    record: StreamRecord,
    params: AgentMessageStreamParams,
  ): Promise<void> {
    try {
      const route = await this.resolveStreamRoute(apiBase);
      const response = await this.fetchStream(apiBase, route, record, params);
      await this.consumeResponse(record, response);
      if (!record.finished) {
        this.finish(record, "done");
        this.emit(record, "done", {
          ...(record.accumulatedText.length > 0
            ? { text: record.accumulatedText }
            : {}),
        });
      }
    } catch (error) {
      if (record.finished) return;
      if (isAbortError(error)) {
        this.finish(record, "cancelled");
        this.emit(record, "cancelled");
        return;
      }
      const serialized = isApiBridgeError(error)
        ? error
        : createApiBridgeError({
            code: "REQUEST_FAILED",
            message:
              error instanceof Error
                ? errorMessage(error)
                : "Runtime stream failed.",
          });
      record.status.error = serialized.message;
      this.finish(record, "error");
      this.emit(record, "error", {
        text: serialized.message,
        payload: serialized,
      });
      this.options.log?.(
        `stream ${record.status.streamId} failed: ${serialized.message}`,
      );
    }
  }

  private async resolveStreamRoute(apiBase: string): Promise<StreamRoute> {
    if (this.discovery === null) {
      this.discovery = await discoverRuntimeApiRoutes({
        apiBase,
        refresh: false,
      });
    }
    const discovered = findAvailableStreamingRoute(this.discovery, [
      "stream.conversationMessage",
      "stream.conversationMessageQuery",
      "stream.openaiCompat",
      "stream.anthropicCompat",
    ]);
    return (
      this.routeFromDiscovery(discovered) ?? REAL_CONVERSATION_STREAM_ROUTE
    );
  }

  private routeFromDiscovery(
    route: StreamingRouteStatus | null,
  ): StreamRoute | null {
    if (route === null) return null;
    return { name: route.name, method: route.method, path: route.path };
  }

  private async fetchStream(
    apiBase: string,
    route: StreamRoute,
    record: StreamRecord,
    params: AgentMessageStreamParams,
  ): Promise<Response> {
    const path = this.resolveRoutePath(route.path, record);
    const headers = new Headers({
      Accept: "text/event-stream, application/json",
    });
    const token = resolveAuthToken(this.options);
    if (token !== null) headers.set("Authorization", `Bearer ${token}`);
    const init: RequestInit = {
      method: route.method,
      headers,
      signal: record.controller.signal,
    };
    if (route.method === "POST") {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(this.requestBody(route, record, params));
    }
    const response = await fetch(joinApiPath(apiBase, path), init);
    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw createApiBridgeError({
        code:
          response.status === 404 || response.status === 405
            ? "ROUTE_UNAVAILABLE"
            : "REQUEST_FAILED",
        message: `Runtime stream request failed with HTTP ${response.status}.`,
        method: route.method,
        path,
        status: response.status,
        details: details.slice(0, 2000),
      });
    }
    return response;
  }

  private async consumeResponse(
    record: StreamRecord,
    response: Response,
  ): Promise<void> {
    const contentType = response.headers.get("content-type");
    if (response.body === null) {
      const text = await response.text();
      this.consumeTextPayload(record, text, contentType);
      return;
    }
    if (contentTypeIsEventStream(contentType)) {
      await this.consumeSse(record, response.body);
      return;
    }
    if (contentTypeIsJson(contentType)) {
      const raw = await response.text();
      this.consumeTextPayload(record, raw, contentType);
      return;
    }
    await this.consumeLines(record, response.body);
  }

  private async consumeSse(
    record: StreamRecord,
    body: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    const parser = new SSEParser();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const events = parser.push(decoder.decode(value, { stream: true }));
      this.consumeSseEvents(record, events);
      if (record.finished) {
        await reader.cancel("stream terminal event").catch(() => {});
        return;
      }
    }
    this.consumeSseEvents(record, parser.flush());
  }

  private async consumeLines(
    record: StreamRecord,
    body: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) this.consumeLine(record, line);
        if (record.finished) {
          await reader.cancel("stream terminal event").catch(() => {});
          return;
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
    if (buffer.trim().length > 0) this.consumeLine(record, buffer.trim());
  }

  private consumeSseEvents(
    record: StreamRecord,
    events: ParsedSSEEvent[],
  ): void {
    for (const event of events) {
      if (event.data === undefined) continue;
      if (event.data === "[DONE]") {
        this.finish(record, "done");
        this.emit(record, "done", { raw: event.raw });
        continue;
      }
      try {
        const parsed = parseJsonPayload(event.data);
        this.emitNormalized(record, parsed);
      } catch {
        this.emit(record, "snapshot", {
          text: event.data,
          raw: event.raw,
        });
      }
    }
  }

  private consumeLine(record: StreamRecord, line: string): void {
    try {
      this.emitNormalized(record, parseJsonPayload(line));
    } catch {
      this.emit(record, "snapshot", { text: line, raw: line });
    }
  }

  private consumeTextPayload(
    record: StreamRecord,
    text: string,
    contentType: string | null,
  ): void {
    if (text.trim().length === 0) return;
    if (contentTypeIsJson(contentType)) {
      try {
        this.emitNormalized(record, parseJsonPayload(text));
        return;
      } catch {
        this.emit(record, "snapshot", { text, raw: text });
        return;
      }
    }
    this.emit(record, "snapshot", { text, raw: text });
  }

  private emitNormalized(record: StreamRecord, payload: unknown): void {
    const events = normalizeStreamEvent(record, payload);
    for (const event of events) {
      if (event.messageId !== undefined) record.messageId = event.messageId;
      this.options.emit(eventNameForKind(event.kind), event);
      if (event.kind === "done") {
        this.finish(record, "done");
      } else if (event.kind === "error") {
        record.status.error = event.text ?? "Runtime stream error";
        this.finish(record, "error");
      } else if (event.kind === "cancelled") {
        this.finish(record, "cancelled");
      }
    }
  }

  private emit(
    record: StreamRecord,
    kind: StreamEventKind,
    input: Omit<
      AgentMessageStreamEvent,
      "streamId" | "kind" | "timestamp"
    > = {},
  ): void {
    this.options.emit(eventNameForKind(kind), streamEvent(record, kind, input));
  }

  private finish(
    record: StreamRecord,
    kind: "done" | "error" | "cancelled",
  ): void {
    if (record.finished) return;
    record.finished = true;
    record.status.active = false;
    if (kind === "cancelled") {
      record.status.cancelledAt = new Date().toISOString();
    } else {
      record.status.completedAt = new Date().toISOString();
    }
    this.active.delete(record.status.streamId);
    this.history.set(record.status.streamId, record.status);
    while (this.history.size > STREAM_HISTORY_LIMIT) {
      const oldest = this.history.keys().next().value;
      if (typeof oldest !== "string") break;
      this.history.delete(oldest);
    }
  }

  private requestBody(
    route: StreamRoute,
    record: StreamRecord,
    params: AgentMessageStreamParams,
  ): JsonObject {
    const metadata = {
      ...(params.metadata ?? {}),
      ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
      ...(params.attachments === undefined
        ? {}
        : { attachments: params.attachments }),
    };
    if (route.name === "stream.openaiCompat") {
      return {
        model: params.agentId ?? "eliza",
        stream: true,
        messages: [{ role: "user", content: record.text }],
        conversationId: record.conversationId,
        metadata,
      };
    }
    if (route.name === "stream.anthropicCompat") {
      return {
        model: params.agentId ?? "eliza",
        stream: true,
        messages: [{ role: "user", content: record.text }],
        conversationId: record.conversationId,
        metadata,
      };
    }
    return {
      text: record.text,
      channelType: "DM",
      source: "elizalaunch",
      ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
    };
  }

  private resolveRoutePath(routePath: string, record: StreamRecord): string {
    if (!routePath.includes(":conversationId")) {
      if (routePath.endsWith("?stream=true")) return routePath;
      return routePath;
    }
    if (record.conversationId === undefined) {
      throw createApiBridgeError({
        code: "DECODE_FAILED",
        message: "Streaming route requires a conversationId.",
        method: "POST",
        path: routePath,
      });
    }
    return routePath.replace(
      ":conversationId",
      encodeURIComponent(record.conversationId),
    );
  }

  private async createConversation(
    apiBase: string,
    params: AgentMessageStreamParams,
  ): Promise<string> {
    const body: JsonObject = {
      title: titleFromText(params.text),
      metadata: {
        source: "elizalaunch",
        ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
      },
    };
    const response = await this.requestJson(apiBase, {
      method: "POST",
      path: "/api/conversations",
      body,
    });
    const id = idFromResponse(response);
    if (id === undefined) {
      throw createApiBridgeError({
        code: "DECODE_FAILED",
        message: "Conversation creation response did not include an id.",
        method: "POST",
        path: "/api/conversations",
        details: response,
      });
    }
    return id;
  }

  private async requestJson(
    apiBase: string,
    options: { method: "POST"; path: string; body: JsonObject },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      STREAM_REQUEST_TIMEOUT_MS,
    );
    try {
      const headers = new Headers({
        Accept: "application/json",
        "Content-Type": "application/json",
      });
      const token = resolveAuthToken(this.options);
      if (token !== null) headers.set("Authorization", `Bearer ${token}`);
      const response = await fetch(joinApiPath(apiBase, options.path), {
        method: options.method,
        headers,
        body: JSON.stringify(options.body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw createApiBridgeError({
          code:
            response.status === 404 || response.status === 405
              ? "ROUTE_UNAVAILABLE"
              : "REQUEST_FAILED",
          message: `Runtime API request failed with HTTP ${response.status}.`,
          method: options.method,
          path: options.path,
          status: response.status,
          details: text.slice(0, 2000),
        });
      }
      return text.trim().length === 0 ? { ok: true } : parseJsonPayload(text);
    } catch (error) {
      if (isApiBridgeError(error)) throw error;
      throw createApiBridgeError({
        code: "REQUEST_FAILED",
        message:
          error instanceof Error
            ? errorMessage(error)
            : "Runtime API request failed.",
        method: options.method,
        path: options.path,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private requireApiBase(): string {
    const apiBase = this.options.getApiBase();
    if (apiBase === null || apiBase.trim().length === 0) {
      throw createApiBridgeError({
        code: "API_BASE_MISSING",
        message: "Runtime API base is not configured.",
      });
    }
    return apiBase.trim();
  }
}
