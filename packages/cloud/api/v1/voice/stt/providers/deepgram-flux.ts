/**
 * Server-side Deepgram Flux realtime STT adapter for the cloud voice surface.
 * The route layer owns authentication, billing, and response shaping; this
 * module owns only Flux connection setup, chunk validation, protocol event
 * mapping, and deterministic cleanup. Deepgram's semantic turn detector is the
 * only turn boundary source here, so callers must not layer local VAD decisions
 * onto these events.
 */

export const DEEPGRAM_FLUX_LISTEN_URL = "wss://api.deepgram.com/v2/listen";
export const DEEPGRAM_FLUX_DEFAULT_MODEL = "flux-general-en";
export const DEEPGRAM_FLUX_SAMPLE_RATE = 16_000;
export const DEEPGRAM_FLUX_CHANNELS = 1;
export const DEEPGRAM_FLUX_AUDIO_ENCODING = "linear16";
export const DEEPGRAM_FLUX_CHUNK_MILLISECONDS = 80;
export const DEEPGRAM_FLUX_CHUNK_BYTES = 2_560;

const DEFAULT_EAGER_EOT_THRESHOLD = 0.35;
const DEFAULT_EOT_THRESHOLD = 0.8;
const DEFAULT_EOT_TIMEOUT_MS = 5_000;
const DEFAULT_CLOSE_CODE = 1000;

export type DeepgramFluxMetricName =
  | "deepgram_flux_connected"
  | "deepgram_flux_audio_chunk_sent"
  | "deepgram_flux_protocol_event"
  | "deepgram_flux_malformed_event"
  | "deepgram_flux_closed";

export type DeepgramFluxMetric = {
  name: DeepgramFluxMetricName;
  value: number;
  tags?: Record<string, string>;
};

export type DeepgramFluxMetricsHooks = {
  onMetric?: (metric: DeepgramFluxMetric) => void;
};

export type DeepgramFluxConfigInput = {
  deepgramApiKey?: string;
  baseUrl?: string;
  model?: string;
  eagerEotThreshold?: number | string;
  eotThreshold?: number | string;
  eotTimeoutMs?: number | string;
};

export type DeepgramFluxConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  eagerEotThreshold: number;
  eotThreshold: number;
  eotTimeoutMs: number;
};

export type DeepgramFluxTransportRequest = {
  url: string;
  headers: Record<string, string>;
};

export type DeepgramFluxWebSocketFactory = (
  request: DeepgramFluxTransportRequest,
) => DeepgramFluxWebSocket;

export type DeepgramFluxWebSocketEventMap = {
  open: Event;
  message: MessageEvent;
  error: Event;
  close: CloseEvent;
};

export type DeepgramFluxWebSocket = {
  readyState: number;
  binaryType?: BinaryType;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof DeepgramFluxWebSocketEventMap>(
    type: K,
    listener: (event: DeepgramFluxWebSocketEventMap[K]) => void,
  ): void;
  removeEventListener<K extends keyof DeepgramFluxWebSocketEventMap>(
    type: K,
    listener: (event: DeepgramFluxWebSocketEventMap[K]) => void,
  ): void;
};

export type DeepgramFluxTurnMetadata = {
  requestId?: string;
  sequenceId?: number;
  turnIndex?: number;
  audioWindowStart?: number;
  audioWindowEnd?: number;
  transcript: string;
  words: readonly unknown[];
  endOfTurnConfidence?: number;
  raw: Record<string, unknown>;
};

export type DeepgramFluxStartOfTurnEvent = DeepgramFluxTurnMetadata & {
  type: "start-of-turn";
};

export type DeepgramFluxTranscriptUpdateEvent = DeepgramFluxTurnMetadata & {
  type: "transcript-update";
};

export type DeepgramFluxEagerEndOfTurnEvent = DeepgramFluxTurnMetadata & {
  type: "eager-end-of-turn";
};

export type DeepgramFluxTurnResumedEvent = DeepgramFluxTurnMetadata & {
  type: "turn-resumed";
};

export type DeepgramFluxEndOfTurnEvent = DeepgramFluxTurnMetadata & {
  type: "end-of-turn";
};

export type DeepgramFluxErrorEvent = {
  type: "error";
  code: string;
  message: string;
  cause?: unknown;
  raw?: Record<string, unknown>;
};

export type DeepgramFluxCloseEvent = {
  type: "close";
  code: number;
  reason: string;
  wasClean: boolean;
};

export type DeepgramFluxRealtimeEvent =
  | DeepgramFluxStartOfTurnEvent
  | DeepgramFluxTranscriptUpdateEvent
  | DeepgramFluxEagerEndOfTurnEvent
  | DeepgramFluxTurnResumedEvent
  | DeepgramFluxEndOfTurnEvent
  | DeepgramFluxErrorEvent
  | DeepgramFluxCloseEvent;

export type DeepgramFluxRealtimeEventHandler = (
  event: DeepgramFluxRealtimeEvent,
) => void;

export type DeepgramFluxSessionOptions = DeepgramFluxConfigInput & {
  webSocketFactory: DeepgramFluxWebSocketFactory;
  signal?: AbortSignal;
  hooks?: DeepgramFluxMetricsHooks;
  onEvent: DeepgramFluxRealtimeEventHandler;
};

export type DeepgramFluxRealtimeSession = {
  socket: DeepgramFluxWebSocket;
  url: string;
  sendAudioChunk(chunk: ArrayBuffer | ArrayBufferView): void;
  close(reason?: string): void;
  cancel(reason?: string): void;
};

export class DeepgramFluxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepgramFluxConfigError";
  }
}

export class DeepgramFluxAudioChunkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepgramFluxAudioChunkError";
  }
}

export class DeepgramFluxConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepgramFluxConnectionError";
  }
}

export function resolveDeepgramFluxConfig(
  input: DeepgramFluxConfigInput,
): DeepgramFluxConfig {
  const apiKey = input.deepgramApiKey?.trim();
  if (!apiKey) {
    throw new DeepgramFluxConfigError("DEEPGRAM_API_KEY is required");
  }

  const eagerEotThreshold = resolveTunable(
    "eager_eot_threshold",
    input.eagerEotThreshold,
    DEFAULT_EAGER_EOT_THRESHOLD,
    0.3,
    0.9,
  );
  const eotThreshold = resolveTunable(
    "eot_threshold",
    input.eotThreshold,
    DEFAULT_EOT_THRESHOLD,
    0.5,
    0.9,
  );
  if (eagerEotThreshold > eotThreshold) {
    throw new DeepgramFluxConfigError(
      "eager_eot_threshold must be less than or equal to eot_threshold",
    );
  }

  return {
    apiKey,
    baseUrl: resolveBaseUrl(input.baseUrl),
    model: resolveModel(input.model),
    eagerEotThreshold,
    eotThreshold,
    eotTimeoutMs: resolveTunable(
      "eot_timeout_ms",
      input.eotTimeoutMs,
      DEFAULT_EOT_TIMEOUT_MS,
      500,
      10_000,
    ),
  };
}

export function buildDeepgramFluxListenUrl(config: DeepgramFluxConfig): string {
  const url = new URL(config.baseUrl);
  url.searchParams.set("encoding", DEEPGRAM_FLUX_AUDIO_ENCODING);
  url.searchParams.set("sample_rate", String(DEEPGRAM_FLUX_SAMPLE_RATE));
  url.searchParams.set("channels", String(DEEPGRAM_FLUX_CHANNELS));
  url.searchParams.set("model", config.model);
  url.searchParams.set("eager_eot_threshold", String(config.eagerEotThreshold));
  url.searchParams.set("eot_threshold", String(config.eotThreshold));
  url.searchParams.set("eot_timeout_ms", String(config.eotTimeoutMs));
  return url.toString();
}

export function validateDeepgramFluxAudioChunk(
  chunk: ArrayBuffer | ArrayBufferView,
): void {
  if (chunk.byteLength !== DEEPGRAM_FLUX_CHUNK_BYTES) {
    throw new DeepgramFluxAudioChunkError(
      `Deepgram Flux expects 80ms linear16 mono 16kHz chunks (${DEEPGRAM_FLUX_CHUNK_BYTES} bytes), received ${chunk.byteLength} bytes`,
    );
  }
}

export function createDeepgramFluxRealtimeSession(
  options: DeepgramFluxSessionOptions,
): DeepgramFluxRealtimeSession {
  const config = resolveDeepgramFluxConfig(options);
  const url = buildDeepgramFluxListenUrl(config);
  const socket = options.webSocketFactory({
    url,
    headers: {
      Authorization: `Token ${config.apiKey}`,
    },
  });
  let cleanedUp = false;
  let gracefulCloseRequested = false;

  socket.binaryType = "arraybuffer";

  const emit = (event: DeepgramFluxRealtimeEvent) => {
    options.onEvent(event);
  };
  const metric = (metric: DeepgramFluxMetric) => {
    try {
      options.hooks?.onMetric?.(metric);
    } catch (error) {
      // error-policy:J7 metrics are best-effort, but hook failures remain visible
      // as typed adapter events without interrupting audio or protocol handling.
      emit({
        type: "error",
        code: "metrics_hook_error",
        message: "Deepgram Flux metrics hook failed",
        cause: error,
      });
    }
  };

  const onOpen = () => {
    metric({ name: "deepgram_flux_connected", value: 1 });
  };

  const onMessage = (event: MessageEvent) => {
    const mapped = mapDeepgramFluxMessage(event.data);
    if (mapped.type === "error" && mapped.code === "malformed_event") {
      metric({
        name: "deepgram_flux_malformed_event",
        value: 1,
      });
    } else {
      metric({
        name: "deepgram_flux_protocol_event",
        value: 1,
        tags: { type: mapped.type },
      });
    }
    emit(mapped);
  };

  const onError = (event: Event) => {
    emit({
      type: "error",
      code: "transport_error",
      message: "Deepgram Flux WebSocket transport reported an error",
      cause: event,
    });
  };

  const onClose = (event: CloseEvent) => {
    cleanup();
    metric({
      name: "deepgram_flux_closed",
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

  const onAbort = () => {
    cancelSocket("cancelled");
  };

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    socket.removeEventListener("open", onOpen);
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    options.signal?.removeEventListener("abort", onAbort);
  };

  const cancelSocket = (reason: string) => {
    if (cleanedUp) {
      return;
    }
    cleanup();
    socket.close(DEFAULT_CLOSE_CODE, reason);
    metric({
      name: "deepgram_flux_closed",
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

  socket.addEventListener("open", onOpen);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  if (options.signal?.aborted) {
    cancelSocket("cancelled");
  }

  return {
    socket,
    url,
    sendAudioChunk(chunk: ArrayBuffer | ArrayBufferView) {
      if (cleanedUp || gracefulCloseRequested || socket.readyState !== 1) {
        throw new DeepgramFluxConnectionError(
          "Deepgram Flux session is not open",
        );
      }
      validateDeepgramFluxAudioChunk(chunk);
      socket.send(chunk);
      metric({ name: "deepgram_flux_audio_chunk_sent", value: 1 });
    },
    close(reason = "client-close") {
      if (cleanedUp || gracefulCloseRequested) {
        return;
      }
      if (socket.readyState !== 1) {
        cancelSocket(reason);
        return;
      }
      gracefulCloseRequested = true;
      socket.send(JSON.stringify({ type: "CloseStream" }));
    },
    cancel(reason = "cancelled") {
      cancelSocket(reason);
    },
  };
}

export function mapDeepgramFluxMessage(
  data: unknown,
): DeepgramFluxRealtimeEvent {
  const parsed = parseDeepgramFluxMessage(data);
  if (!parsed.ok) {
    return {
      type: "error",
      code: "malformed_event",
      message: parsed.message,
      cause: parsed.cause,
    };
  }

  const messageType = stringField(parsed.value, "type");
  if (messageType === "Error") {
    return {
      type: "error",
      code: stringField(parsed.value, "code") ?? "deepgram_error",
      message:
        stringField(parsed.value, "description") ??
        stringField(parsed.value, "message") ??
        "Deepgram Flux returned an error",
      raw: parsed.value,
    };
  }
  if (messageType !== "TurnInfo") {
    return malformedProtocolEvent(
      `Unsupported Deepgram Flux message type: ${messageType ?? "missing"}`,
      { raw: parsed.value },
    );
  }

  const eventName = stringField(parsed.value, "event");
  if (
    eventName !== "StartOfTurn" &&
    isKnownTurnEvent(eventName) &&
    (stringField(parsed.value, "transcript") === undefined ||
      !Array.isArray(parsed.value.words))
  ) {
    return malformedProtocolEvent(
      `Deepgram Flux ${eventName} event is missing transcript or words`,
      { raw: parsed.value },
    );
  }
  const turn = mapTurnMetadata(parsed.value);

  switch (eventName) {
    case "StartOfTurn":
      return { type: "start-of-turn", ...turn };
    case "Update":
      return { type: "transcript-update", ...turn };
    case "EagerEndOfTurn":
      return { type: "eager-end-of-turn", ...turn };
    case "TurnResumed":
      return { type: "turn-resumed", ...turn };
    case "EndOfTurn":
      return { type: "end-of-turn", ...turn };
    default:
      return malformedProtocolEvent(
        `Unsupported Deepgram Flux TurnInfo event: ${eventName ?? "missing"}`,
        { raw: parsed.value },
      );
  }
}

function isKnownTurnEvent(
  event: string | undefined,
): event is
  | "StartOfTurn"
  | "Update"
  | "EagerEndOfTurn"
  | "TurnResumed"
  | "EndOfTurn" {
  return (
    event === "StartOfTurn" ||
    event === "Update" ||
    event === "EagerEndOfTurn" ||
    event === "TurnResumed" ||
    event === "EndOfTurn"
  );
}

function resolveBaseUrl(configured: string | undefined): string {
  const value = configured?.trim() || DEEPGRAM_FLUX_LISTEN_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // error-policy:J3 Deployment config is untrusted text; invalid URLs become
    // an explicit config failure before any network transport is constructed.
    throw new DeepgramFluxConfigError("Deepgram Flux base URL is invalid");
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new DeepgramFluxConfigError(
      "Deepgram Flux base URL must use ws: or wss:",
    );
  }
  if (url.pathname !== "/v2/listen") {
    throw new DeepgramFluxConfigError(
      "Deepgram Flux base URL must target /v2/listen",
    );
  }
  return url.toString();
}

function resolveModel(configured: string | undefined): string {
  const model = configured?.trim() || DEEPGRAM_FLUX_DEFAULT_MODEL;
  if (model !== DEEPGRAM_FLUX_DEFAULT_MODEL) {
    throw new DeepgramFluxConfigError(
      `Deepgram Flux initially supports only ${DEEPGRAM_FLUX_DEFAULT_MODEL}`,
    );
  }
  return model;
}

function resolveTunable(
  name: string,
  configured: number | string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  let value: number | undefined;
  if (typeof configured === "string") {
    const trimmed = configured.trim();
    value = trimmed ? Number(trimmed) : undefined;
  } else {
    value = configured;
  }
  const resolved = value ?? defaultValue;
  if (!Number.isFinite(resolved) || resolved < minimum || resolved > maximum) {
    throw new DeepgramFluxConfigError(
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return resolved;
}

type ParsedDeepgramFluxMessage =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string; cause?: unknown };

function parseDeepgramFluxMessage(data: unknown): ParsedDeepgramFluxMessage {
  if (typeof data !== "string") {
    return {
      ok: false,
      message: "Deepgram Flux message payload must be JSON text",
    };
  }

  try {
    const parsed: unknown = JSON.parse(data);
    if (!isRecord(parsed)) {
      return {
        ok: false,
        message: "Deepgram Flux message payload must be a JSON object",
      };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    // error-policy:J3 Deepgram emits untrusted JSON text; parse failures become
    // an explicit adapter error event instead of a fake transcript.
    return {
      ok: false,
      message: "Deepgram Flux message payload is not valid JSON",
      cause: error,
    };
  }
}

function mapTurnMetadata(
  raw: Record<string, unknown>,
): DeepgramFluxTurnMetadata {
  const transcript = stringField(raw, "transcript") ?? "";
  const words = raw.words;
  return {
    requestId: stringField(raw, "request_id"),
    sequenceId: numberField(raw, "sequence_id"),
    turnIndex: numberField(raw, "turn_index"),
    audioWindowStart: numberField(raw, "audio_window_start"),
    audioWindowEnd: numberField(raw, "audio_window_end"),
    transcript,
    words: Array.isArray(words) ? words : [],
    endOfTurnConfidence: numberField(raw, "end_of_turn_confidence"),
    raw,
  };
}

function malformedProtocolEvent(
  message: string,
  options: { raw?: Record<string, unknown>; cause?: unknown },
): DeepgramFluxErrorEvent {
  return {
    type: "error",
    code: "malformed_event",
    message,
    raw: options.raw,
    cause: options.cause,
  };
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

function numberField(
  value: Record<string, unknown>,
  field: string,
): number | undefined {
  const candidate = value[field];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}
