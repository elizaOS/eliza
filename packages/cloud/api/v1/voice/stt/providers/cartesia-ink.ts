/**
 * Server-side Cartesia Ink realtime STT adapter for the cloud voice surface.
 * The voice-session orchestrator supplies raw mono PCM and consumes normalized
 * turn events; this module owns provider authentication, protocol validation,
 * native turn detection, graceful draining, and deterministic cleanup.
 */

export const CARTESIA_INK_WEBSOCKET_URL =
  "wss://api.cartesia.ai/stt/turns/websocket";
export const CARTESIA_INK_MODEL_ID = "ink-2";
export const CARTESIA_INK_API_VERSION = "2025-11-04";
export const CARTESIA_INK_SAMPLE_RATE = 16_000;
export const CARTESIA_INK_AUDIO_ENCODING = "pcm_s16le";
export const CARTESIA_INK_CHUNK_MILLISECONDS = 100;
export const CARTESIA_INK_CHUNK_BYTES = 3_200;
// Lowest supported semantic start threshold: phone callers must get the floor
// before buffered TTS can talk over the beginning of their interruption.
export const CARTESIA_INK_TURN_START_THRESHOLD = 0.5;
export const CARTESIA_INK_TURN_EAGER_END_THRESHOLD = 0.4;
export const CARTESIA_INK_TURN_END_THRESHOLD = 0.3;
export const CARTESIA_INK_TURN_END_TIMEOUT_MILLISECONDS = 1_200;

const DEFAULT_CLOSE_CODE = 1000;

export type CartesiaInkMetricName =
  | "cartesia_ink_connected"
  | "cartesia_ink_audio_chunk_sent"
  | "cartesia_ink_protocol_event"
  | "cartesia_ink_malformed_event"
  | "cartesia_ink_closed";

export interface CartesiaInkMetric {
  name: CartesiaInkMetricName;
  value: number;
  tags?: Record<string, string>;
}

export interface CartesiaInkMetricsHooks {
  onMetric?: (metric: CartesiaInkMetric) => void;
}

export interface CartesiaInkConfigInput {
  cartesiaApiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface CartesiaInkConfig {
  apiKey: string;
  baseUrl: string;
  model: typeof CARTESIA_INK_MODEL_ID;
}

export interface CartesiaInkTransportRequest {
  url: string;
  headers: Record<string, string>;
}

export type CartesiaInkWebSocketFactory = (
  request: CartesiaInkTransportRequest,
) => CartesiaInkWebSocket;

export interface CartesiaInkWebSocketEventMap {
  open: Event;
  message: MessageEvent;
  error: Event;
  close: CloseEvent;
}

export interface CartesiaInkWebSocket {
  readyState: number;
  binaryType?: BinaryType;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof CartesiaInkWebSocketEventMap>(
    type: K,
    listener: (event: CartesiaInkWebSocketEventMap[K]) => void,
  ): void;
  removeEventListener<K extends keyof CartesiaInkWebSocketEventMap>(
    type: K,
    listener: (event: CartesiaInkWebSocketEventMap[K]) => void,
  ): void;
}

export interface CartesiaInkTurnMetadata {
  requestId?: string;
  transcript: string;
  raw: Record<string, unknown>;
}

export type CartesiaInkRealtimeEvent =
  | ({ type: "connected" } & Omit<CartesiaInkTurnMetadata, "transcript">)
  | ({ type: "start-of-turn" } & CartesiaInkTurnMetadata)
  | ({ type: "transcript-update" } & CartesiaInkTurnMetadata)
  | ({ type: "eager-end-of-turn" } & CartesiaInkTurnMetadata)
  | ({ type: "turn-resumed" } & CartesiaInkTurnMetadata)
  | ({ type: "end-of-turn" } & CartesiaInkTurnMetadata)
  | {
      type: "error";
      code: string;
      message: string;
      cause?: unknown;
      raw?: Record<string, unknown>;
    }
  | {
      type: "close";
      code: number;
      reason: string;
      wasClean: boolean;
    };

export interface CartesiaInkSessionOptions extends CartesiaInkConfigInput {
  webSocketFactory: CartesiaInkWebSocketFactory;
  signal?: AbortSignal;
  hooks?: CartesiaInkMetricsHooks;
  onEvent: (event: CartesiaInkRealtimeEvent) => void;
}

export interface CartesiaInkRealtimeSession {
  socket: CartesiaInkWebSocket;
  url: string;
  sendAudioChunk(chunk: ArrayBuffer | ArrayBufferView): void;
  close(reason?: string): void;
  cancel(reason?: string): void;
}

export class CartesiaInkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartesiaInkConfigError";
  }
}

export class CartesiaInkAudioChunkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartesiaInkAudioChunkError";
  }
}

export class CartesiaInkConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartesiaInkConnectionError";
  }
}

export function resolveCartesiaInkConfig(
  input: CartesiaInkConfigInput,
): CartesiaInkConfig {
  const apiKey = input.cartesiaApiKey?.trim();
  if (!apiKey) {
    throw new CartesiaInkConfigError("CARTESIA_API_KEY is required");
  }

  const model = input.model?.trim() || CARTESIA_INK_MODEL_ID;
  if (model !== CARTESIA_INK_MODEL_ID) {
    throw new CartesiaInkConfigError(
      `Cartesia realtime STT supports only ${CARTESIA_INK_MODEL_ID}`,
    );
  }

  return {
    apiKey,
    baseUrl: resolveBaseUrl(input.baseUrl),
    model,
  };
}

export function buildCartesiaInkUrl(config: CartesiaInkConfig): string {
  const url = new URL(config.baseUrl);
  url.searchParams.set("model", config.model);
  url.searchParams.set("encoding", CARTESIA_INK_AUDIO_ENCODING);
  url.searchParams.set("sample_rate", String(CARTESIA_INK_SAMPLE_RATE));
  url.searchParams.set("cartesia_version", CARTESIA_INK_API_VERSION);
  url.searchParams.set(
    "turn_start_threshold",
    String(CARTESIA_INK_TURN_START_THRESHOLD),
  );
  url.searchParams.set(
    "turn_eager_end_threshold",
    String(CARTESIA_INK_TURN_EAGER_END_THRESHOLD),
  );
  url.searchParams.set(
    "turn_end_threshold",
    String(CARTESIA_INK_TURN_END_THRESHOLD),
  );
  url.searchParams.set(
    "turn_end_timeout_ms",
    String(CARTESIA_INK_TURN_END_TIMEOUT_MILLISECONDS),
  );
  return url.toString();
}

export function validateCartesiaInkAudioChunk(
  chunk: ArrayBuffer | ArrayBufferView,
): void {
  if (chunk.byteLength !== CARTESIA_INK_CHUNK_BYTES) {
    throw new CartesiaInkAudioChunkError(
      `Cartesia Ink expects 100ms pcm_s16le mono 16kHz chunks (${CARTESIA_INK_CHUNK_BYTES} bytes), received ${chunk.byteLength} bytes`,
    );
  }
}

export function createCartesiaInkRealtimeSession(
  options: CartesiaInkSessionOptions,
): CartesiaInkRealtimeSession {
  const config = resolveCartesiaInkConfig(options);
  const url = buildCartesiaInkUrl(config);
  const socket = options.webSocketFactory({
    url,
    headers: {
      "X-API-Key": config.apiKey,
      "Cartesia-Version": CARTESIA_INK_API_VERSION,
    },
  });
  let cleanedUp = false;
  let gracefulCloseRequested = false;

  socket.binaryType = "arraybuffer";

  const emit = (event: CartesiaInkRealtimeEvent) => {
    options.onEvent(event);
  };
  const metric = (event: CartesiaInkMetric) => {
    try {
      options.hooks?.onMetric?.(event);
    } catch (error) {
      // error-policy:J7 metrics are best-effort, but a broken hook remains
      // visible without interrupting the provider protocol or audio stream.
      emit({
        type: "error",
        code: "metrics_hook_error",
        message: "Cartesia Ink metrics hook failed",
        cause: error,
      });
    }
  };

  const onOpen = () => {
    metric({ name: "cartesia_ink_connected", value: 1 });
    emit({ type: "connected", raw: {} });
  };

  const onMessage = (event: MessageEvent) => {
    const mapped = mapCartesiaInkMessage(event.data);
    metric({
      name:
        mapped.type === "error" && mapped.code === "malformed_event"
          ? "cartesia_ink_malformed_event"
          : "cartesia_ink_protocol_event",
      value: 1,
      tags: { type: mapped.type },
    });
    emit(mapped);
  };

  const onError = (event: Event) => {
    emit({
      type: "error",
      code: "transport_error",
      message: "Cartesia Ink WebSocket transport reported an error",
      cause: event,
    });
  };

  const inertErrorHandler = () => {};

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    socket.removeEventListener("open", onOpen);
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    options.signal?.removeEventListener("abort", onAbort);
    socket.addEventListener("error", inertErrorHandler);
  };

  const onClose = (event: CloseEvent) => {
    cleanup();
    metric({
      name: "cartesia_ink_closed",
      value: 1,
      tags: { code: String(event.code) },
    });
    emit({
      type: "close",
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });
  };

  const cancelSocket = (reason: string) => {
    if (cleanedUp) return;
    cleanup();
    socket.close(DEFAULT_CLOSE_CODE, reason);
    metric({
      name: "cartesia_ink_closed",
      value: 1,
      tags: { code: String(DEFAULT_CLOSE_CODE) },
    });
    emit({
      type: "close",
      code: DEFAULT_CLOSE_CODE,
      reason,
      wasClean: true,
    });
  };

  const onAbort = () => {
    cancelSocket("cancelled");
  };

  socket.addEventListener("open", onOpen);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  if (options.signal?.aborted) cancelSocket("cancelled");

  return {
    socket,
    url,
    sendAudioChunk(chunk) {
      if (cleanedUp || gracefulCloseRequested || socket.readyState !== 1) {
        throw new CartesiaInkConnectionError(
          "Cartesia Ink session is not open",
        );
      }
      validateCartesiaInkAudioChunk(chunk);
      socket.send(chunk);
      metric({ name: "cartesia_ink_audio_chunk_sent", value: 1 });
    },
    close() {
      if (cleanedUp || gracefulCloseRequested) return;
      if (socket.readyState !== 1) {
        cancelSocket("client-close");
        return;
      }
      gracefulCloseRequested = true;
      socket.send(JSON.stringify({ type: "close" }));
    },
    cancel(reason = "cancelled") {
      cancelSocket(reason);
    },
  };
}

export function mapCartesiaInkMessage(data: unknown): CartesiaInkRealtimeEvent {
  const parsed = parseCartesiaInkMessage(data);
  if (!parsed.ok) {
    return {
      type: "error",
      code: "malformed_event",
      message: parsed.message,
      cause: parsed.cause,
    };
  }

  const messageType = stringField(parsed.value, "type");
  const requestId = stringField(parsed.value, "request_id");
  if (messageType === "error") {
    return {
      type: "error",
      code: stringField(parsed.value, "error_code") ?? "cartesia_ink_error",
      message:
        stringField(parsed.value, "message") ??
        stringField(parsed.value, "title") ??
        "Cartesia Ink returned an error",
      raw: parsed.value,
    };
  }

  if (messageType === "connected") {
    return { type: "connected", requestId, raw: parsed.value };
  }

  if (!isTurnEvent(messageType)) {
    return malformedProtocolEvent(
      `Unsupported Cartesia Ink message type: ${messageType ?? "missing"}`,
      parsed.value,
    );
  }

  const transcript = stringField(parsed.value, "transcript");
  if (turnEventRequiresTranscript(messageType) && transcript === undefined) {
    return malformedProtocolEvent(
      `Cartesia Ink ${messageType} event is missing transcript`,
      parsed.value,
    );
  }
  const turn = {
    requestId,
    transcript: transcript ?? "",
    raw: parsed.value,
  };

  switch (messageType) {
    case "turn.start":
      return { type: "start-of-turn", ...turn };
    case "turn.update":
      return { type: "transcript-update", ...turn };
    case "turn.eager_end":
      return { type: "eager-end-of-turn", ...turn };
    case "turn.resume":
      return { type: "turn-resumed", ...turn };
    case "turn.end":
      return { type: "end-of-turn", ...turn };
  }
}

function resolveBaseUrl(configured: string | undefined): string {
  const value = configured?.trim() || CARTESIA_INK_WEBSOCKET_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // error-policy:J3 deployment configuration is untrusted input and fails
    // explicitly before a provider transport is constructed.
    throw new CartesiaInkConfigError("Cartesia Ink base URL is invalid");
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new CartesiaInkConfigError(
      "Cartesia Ink base URL must use ws: or wss:",
    );
  }
  if (url.pathname !== "/stt/turns/websocket") {
    throw new CartesiaInkConfigError(
      "Cartesia Ink base URL must target /stt/turns/websocket",
    );
  }
  return url.toString();
}

type ParsedCartesiaInkMessage =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string; cause?: unknown };

function parseCartesiaInkMessage(data: unknown): ParsedCartesiaInkMessage {
  if (typeof data !== "string") {
    return {
      ok: false,
      message: "Cartesia Ink message payload must be JSON text",
    };
  }
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isRecord(parsed)) {
      return {
        ok: false,
        message: "Cartesia Ink message payload must be a JSON object",
      };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    // error-policy:J3 provider messages are untrusted JSON; a parse failure is
    // an explicit adapter error and can never become a fabricated transcript.
    return {
      ok: false,
      message: "Cartesia Ink message payload is not valid JSON",
      cause: error,
    };
  }
}

function isTurnEvent(
  value: string | undefined,
): value is
  | "turn.start"
  | "turn.update"
  | "turn.eager_end"
  | "turn.resume"
  | "turn.end" {
  return (
    value === "turn.start" ||
    value === "turn.update" ||
    value === "turn.eager_end" ||
    value === "turn.resume" ||
    value === "turn.end"
  );
}

function turnEventRequiresTranscript(
  value: ReturnType<typeof stringField>,
): boolean {
  return (
    value === "turn.update" ||
    value === "turn.eager_end" ||
    value === "turn.end"
  );
}

function malformedProtocolEvent(
  message: string,
  raw: Record<string, unknown>,
): CartesiaInkRealtimeEvent {
  return { type: "error", code: "malformed_event", message, raw };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const candidate = value[field];
  return typeof candidate === "string" ? candidate : undefined;
}
