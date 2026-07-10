/**
 * Server-side Cartesia Sonic streaming TTS adapter.
 *
 * The module owns only Cartesia's WebSocket protocol mapping: validation,
 * request framing, PCM chunk decoding, cancellation, and provider metadata.
 * Callers remain responsible for phrase chunking, playback, billing, and HTTP
 * route translation.
 */

export const CARTESIA_SONIC_PROVIDER_ID = "cartesia-sonic";
export const CARTESIA_SONIC_MODEL_ID = "sonic-3.5";
export const CARTESIA_API_VERSION = "2026-03-01";
export const CARTESIA_TTS_WEBSOCKET_URL = "wss://api.cartesia.ai/tts/websocket";

const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_LANGUAGE = "en";
const SUPPORTED_SAMPLE_RATES = new Set([8000, 16_000, 22_050, 24_000, 44_100, 48_000]);
const VOICE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CartesiaSonicEncoding = "pcm_s16le" | "pcm_f32le";

export interface CartesiaSonicProviderMetadata {
  readonly provider: typeof CARTESIA_SONIC_PROVIDER_ID;
  readonly modelId: typeof CARTESIA_SONIC_MODEL_ID;
  readonly apiVersion: typeof CARTESIA_API_VERSION;
  readonly transport: "websocket";
  readonly output: {
    readonly container: "raw";
    readonly encoding: CartesiaSonicEncoding;
    readonly sampleRate: number;
    readonly channels: number;
  };
}

export interface CartesiaSonicAdapterConfig {
  readonly apiKey: string;
  readonly voiceId: string;
  readonly websocketFactory: CartesiaWebSocketFactory;
  readonly websocketUrl?: string;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly encoding?: CartesiaSonicEncoding;
  readonly language?: string;
  readonly metrics?: CartesiaSonicMetricsHook;
}

export interface CartesiaSonicMetricEvent {
  readonly name:
    | "cartesia_tts_ws_open"
    | "cartesia_tts_first_audio"
    | "cartesia_tts_audio_frame"
    | "cartesia_tts_complete"
    | "cartesia_tts_provider_error"
    | "cartesia_tts_cancelled";
  readonly traceId?: string;
  readonly timestampMs: number;
  readonly attributes: Record<string, string | number | boolean | undefined>;
}

export type CartesiaSonicMetricsHook = (event: CartesiaSonicMetricEvent) => void;

export interface CartesiaSonicStreamOptions {
  readonly contextId?: string;
  readonly traceId?: string;
  readonly language?: string;
  readonly maxBufferDelayMs?: number;
}

export interface CartesiaSonicPhraseInput {
  readonly text: string;
  readonly continueContext: boolean;
  readonly flush?: boolean;
  readonly duration?: number;
  readonly maxBufferDelayMs?: number;
}

export interface CartesiaSonicFirstAudioEvent {
  readonly contextId: string;
  readonly traceId?: string;
  readonly elapsedMs: number;
}

export interface CartesiaSonicAudioFrameEvent {
  readonly bytes: Uint8Array;
  readonly sequence: number;
  readonly contextId: string;
  readonly traceId?: string;
  readonly flushId?: number;
  readonly statusCode?: number;
  readonly stepTimeMs?: number;
}

export interface CartesiaSonicCompleteEvent {
  readonly contextId: string;
  readonly traceId?: string;
  readonly frameCount: number;
}

export interface CartesiaSonicProviderErrorEvent {
  readonly contextId?: string;
  readonly traceId?: string;
  readonly title: string;
  readonly message: string;
  readonly code?: string;
  readonly statusCode?: number;
  readonly requestId?: string;
  readonly docUrl?: string;
}

export interface CartesiaSonicCancelledEvent {
  readonly contextId: string;
  readonly traceId?: string;
  readonly reason?: string;
}

export interface CartesiaSonicStreamCallbacks {
  readonly onFirstAudio?: (event: CartesiaSonicFirstAudioEvent) => void;
  readonly onAudioFrame?: (event: CartesiaSonicAudioFrameEvent) => void;
  readonly onComplete?: (event: CartesiaSonicCompleteEvent) => void;
  readonly onProviderError?: (event: CartesiaSonicProviderErrorEvent) => void;
  readonly onCancelled?: (event: CartesiaSonicCancelledEvent) => void;
}

export interface CartesiaWebSocketFactoryOptions {
  readonly headers: Record<string, string>;
}

export type CartesiaWebSocketFactory = (
  url: string,
  options: CartesiaWebSocketFactoryOptions,
) => CartesiaWebSocketLike;

export interface CartesiaWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(
    type: "error",
    listener: (event: { readonly message?: string; readonly error?: unknown }) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { readonly code?: number; readonly reason?: string }) => void,
  ): void;
}

interface CartesiaGenerationRequest {
  readonly model_id: typeof CARTESIA_SONIC_MODEL_ID;
  readonly transcript: string;
  readonly voice: {
    readonly mode: "id";
    readonly id: string;
  };
  readonly language: string;
  readonly context_id: string;
  readonly output_format: {
    readonly container: "raw";
    readonly encoding: CartesiaSonicEncoding;
    readonly sample_rate: number;
  };
  readonly continue: boolean;
  readonly max_buffer_delay_ms?: number;
  readonly flush?: boolean;
  readonly duration?: number;
}

type CartesiaIncomingMessage =
  | {
      readonly type: "chunk";
      readonly data: string;
      readonly done?: false;
      readonly status_code?: number;
      readonly step_time?: number;
      readonly context_id?: string;
      readonly flush_id?: number;
    }
  | {
      readonly type: "done";
      readonly done: true;
      readonly status_code?: number;
      readonly context_id?: string;
    }
  | {
      readonly type: "flush_done";
      readonly done?: false;
      readonly flush_done?: true;
      readonly flush_id?: number;
      readonly status_code?: number;
      readonly context_id?: string;
    }
  | {
      readonly type: "error";
      readonly done?: true;
      readonly title?: string;
      readonly message?: string;
      readonly error_code?: string;
      readonly status_code?: number;
      readonly doc_url?: string;
      readonly request_id?: string;
      readonly context_id?: string;
    }
  | {
      readonly type: "timestamps" | "phoneme_timestamps";
      readonly done?: false;
      readonly status_code?: number;
      readonly context_id?: string;
    };

export class CartesiaSonicTtsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly context?: Record<string, unknown>,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CartesiaSonicTtsError";
  }
}

export class CartesiaSonicTtsAdapter {
  readonly metadata: CartesiaSonicProviderMetadata;

  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly websocketFactory: CartesiaWebSocketFactory;
  private readonly websocketUrl: string;
  private readonly language: string;
  private readonly metrics?: CartesiaSonicMetricsHook;

  constructor(config: CartesiaSonicAdapterConfig) {
    const normalized = validateCartesiaSonicConfig(config);
    this.apiKey = normalized.apiKey;
    this.voiceId = normalized.voiceId;
    this.websocketFactory = normalized.websocketFactory;
    this.websocketUrl = normalized.websocketUrl;
    this.language = normalized.language;
    this.metrics = normalized.metrics;
    this.metadata = {
      provider: CARTESIA_SONIC_PROVIDER_ID,
      modelId: CARTESIA_SONIC_MODEL_ID,
      apiVersion: CARTESIA_API_VERSION,
      transport: "websocket",
      output: {
        container: "raw",
        encoding: normalized.encoding,
        sampleRate: normalized.sampleRate,
        channels: normalized.channels,
      },
    };
  }

  createStream(
    options: CartesiaSonicStreamOptions,
    callbacks: CartesiaSonicStreamCallbacks,
  ): CartesiaSonicTtsStream {
    return new CartesiaSonicTtsStream({
      apiKey: this.apiKey,
      voiceId: this.voiceId,
      websocketFactory: this.websocketFactory,
      websocketUrl: this.websocketUrl,
      language: options.language ?? this.language,
      metadata: this.metadata,
      contextId: options.contextId ?? crypto.randomUUID(),
      traceId: options.traceId,
      maxBufferDelayMs: options.maxBufferDelayMs,
      callbacks,
      metrics: this.metrics,
    });
  }
}

interface NormalizedConfig {
  readonly apiKey: string;
  readonly voiceId: string;
  readonly websocketFactory: CartesiaWebSocketFactory;
  readonly websocketUrl: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly encoding: CartesiaSonicEncoding;
  readonly language: string;
  readonly metrics?: CartesiaSonicMetricsHook;
}

function validateCartesiaSonicConfig(config: CartesiaSonicAdapterConfig): NormalizedConfig {
  const apiKey = config.apiKey.trim();
  if (!apiKey) {
    throw new CartesiaSonicTtsError("CARTESIA_API_KEY is required", "CONFIG_API_KEY_MISSING");
  }

  const voiceId = config.voiceId.trim();
  if (!VOICE_ID_PATTERN.test(voiceId)) {
    throw new CartesiaSonicTtsError("Cartesia voiceId must be a UUID", "CONFIG_VOICE_ID_INVALID", {
      voiceId,
    });
  }

  const sampleRate = config.sampleRate ?? DEFAULT_SAMPLE_RATE;
  if (!SUPPORTED_SAMPLE_RATES.has(sampleRate)) {
    throw new CartesiaSonicTtsError(
      "Cartesia sampleRate is not supported",
      "CONFIG_SAMPLE_RATE_INVALID",
      { sampleRate },
    );
  }

  const channels = config.channels ?? DEFAULT_CHANNELS;
  if (channels !== DEFAULT_CHANNELS) {
    throw new CartesiaSonicTtsError(
      "Cartesia Sonic streaming output is pinned to mono PCM",
      "CONFIG_CHANNELS_INVALID",
      { channels },
    );
  }

  const encoding = config.encoding ?? "pcm_s16le";
  if (encoding !== "pcm_s16le" && encoding !== "pcm_f32le") {
    throw new CartesiaSonicTtsError(
      "Cartesia encoding is not supported",
      "CONFIG_ENCODING_INVALID",
      {
        encoding,
      },
    );
  }

  const language = (config.language ?? DEFAULT_LANGUAGE).trim();
  if (!language) {
    throw new CartesiaSonicTtsError("Cartesia language is required", "CONFIG_LANGUAGE_INVALID");
  }

  return {
    apiKey,
    voiceId,
    websocketFactory: config.websocketFactory,
    websocketUrl: config.websocketUrl ?? CARTESIA_TTS_WEBSOCKET_URL,
    sampleRate,
    channels,
    encoding,
    language,
    metrics: config.metrics,
  };
}

interface StreamConstructorInput {
  readonly apiKey: string;
  readonly voiceId: string;
  readonly websocketFactory: CartesiaWebSocketFactory;
  readonly websocketUrl: string;
  readonly language: string;
  readonly metadata: CartesiaSonicProviderMetadata;
  readonly contextId: string;
  readonly traceId?: string;
  readonly maxBufferDelayMs?: number;
  readonly callbacks: CartesiaSonicStreamCallbacks;
  readonly metrics?: CartesiaSonicMetricsHook;
}

export class CartesiaSonicTtsStream {
  readonly contextId: string;
  readonly traceId?: string;
  readonly opened: Promise<void>;
  readonly closed: Promise<void>;

  private readonly input: StreamConstructorInput;
  private readonly socket: CartesiaWebSocketLike;
  private readonly startedAt = Date.now();
  private frameSequence = 0;
  private firstAudioEmitted = false;
  private cancelled = false;
  private completed = false;
  private socketOpened = false;
  private openedSettled = false;
  private providerErrorEmitted = false;
  private readonly outboundQueue: string[] = [];
  private resolveOpened!: () => void;
  private rejectOpened!: (error: unknown) => void;
  private resolveClosed!: () => void;

  constructor(input: StreamConstructorInput) {
    this.input = input;
    this.contextId = input.contextId;
    this.traceId = input.traceId;
    this.opened = new Promise<void>((resolve, reject) => {
      this.resolveOpened = resolve;
      this.rejectOpened = reject;
    });
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.socket = input.websocketFactory(buildCartesiaWebSocketUrl(input.websocketUrl), {
      headers: {
        "Cartesia-Version": CARTESIA_API_VERSION,
        "X-API-Key": input.apiKey,
      },
    });
    this.attachSocketListeners();
  }

  sendPhrase(phrase: CartesiaSonicPhraseInput): void {
    if (this.cancelled) {
      throw new CartesiaSonicTtsError(
        "Cannot send a Cartesia phrase after cancellation",
        "STREAM_CANCELLED",
        { contextId: this.contextId },
      );
    }
    if (this.completed) {
      throw new CartesiaSonicTtsError(
        "Cannot send a Cartesia phrase after completion",
        "STREAM_COMPLETED",
        { contextId: this.contextId },
      );
    }

    const payload: CartesiaGenerationRequest = {
      model_id: CARTESIA_SONIC_MODEL_ID,
      transcript: phrase.text,
      voice: { mode: "id", id: this.input.voiceId },
      language: this.input.language,
      context_id: this.contextId,
      output_format: {
        container: "raw",
        encoding: this.input.metadata.output.encoding,
        sample_rate: this.input.metadata.output.sampleRate,
      },
      continue: phrase.continueContext,
      max_buffer_delay_ms: phrase.maxBufferDelayMs ?? this.input.maxBufferDelayMs,
      flush: phrase.flush,
      duration: phrase.duration,
    };
    this.sendOrQueue(JSON.stringify(removeUndefinedFields(payload)));
  }

  finish(): void {
    this.sendPhrase({ text: "", continueContext: false });
  }

  cancel(reason?: string): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.discardQueuedOutbound();
    this.input.callbacks.onCancelled?.({
      contextId: this.contextId,
      traceId: this.traceId,
      reason,
    });
    this.emitMetric("cartesia_tts_cancelled", {
      contextId: this.contextId,
      reason,
    });

    if (this.socket.readyState === 1) {
      try {
        this.socket.send(JSON.stringify({ context_id: this.contextId, cancel: true }));
      } catch (error) {
        // error-policy:J6 best-effort teardown; local cancellation already gates
        // any later audio callbacks for this context.
        this.input.callbacks.onProviderError?.({
          contextId: this.contextId,
          traceId: this.traceId,
          title: "Cartesia cancellation send failed",
          message: error instanceof Error ? error.message : String(error),
          code: "cancel_send_failed",
        });
      }
    }
    this.socket.close(1000, reason);
  }

  private attachSocketListeners(): void {
    this.socket.addEventListener("open", () => {
      if (this.openedSettled || this.cancelled || this.providerErrorEmitted) {
        this.discardQueuedOutbound();
        return;
      }
      this.socketOpened = true;
      this.openedSettled = true;
      this.resolveOpened();
      this.flushQueuedOutbound();
      this.emitMetric("cartesia_tts_ws_open", {
        contextId: this.contextId,
      });
    });
    this.socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });
    this.socket.addEventListener("error", (event) => {
      if (this.cancelled) return;
      this.discardQueuedOutbound();
      const errorEvent = {
        contextId: this.contextId,
        traceId: this.traceId,
        title: "Cartesia WebSocket error",
        message:
          event.message ?? (event.error instanceof Error ? event.error.message : "WebSocket error"),
        code: "websocket_error",
      };
      this.emitProviderError(errorEvent);
      this.rejectOpenedOnce(new CartesiaSonicTtsError(errorEvent.message, errorEvent.code));
    });
    this.socket.addEventListener("close", (event) => {
      if (!this.socketOpened && !this.openedSettled) {
        this.discardQueuedOutbound();
        if (this.cancelled) {
          this.rejectOpenedOnce(
            new CartesiaSonicTtsError(
              "Cartesia WebSocket closed during cancellation",
              "STREAM_CANCELLED",
              { contextId: this.contextId },
            ),
          );
        } else {
          const code = "websocket_closed_before_open";
          const message = event.reason
            ? `Cartesia WebSocket closed before opening: ${event.reason}`
            : "Cartesia WebSocket closed before opening";
          this.emitProviderError({
            contextId: this.contextId,
            traceId: this.traceId,
            title: "Cartesia WebSocket closed before opening",
            message,
            code,
            statusCode: event.code,
          });
          this.rejectOpenedOnce(new CartesiaSonicTtsError(message, code));
        }
      }
      this.resolveClosed();
    });
  }

  private sendOrQueue(data: string): void {
    if (this.socket.readyState === 1) {
      this.socket.send(data);
      return;
    }
    if (this.socket.readyState === 0) {
      this.outboundQueue.push(data);
      return;
    }
    this.socket.send(data);
  }

  private flushQueuedOutbound(): void {
    while (this.outboundQueue.length > 0) {
      const data = this.outboundQueue.shift();
      if (data === undefined) return;
      this.socket.send(data);
    }
  }

  private discardQueuedOutbound(): void {
    this.outboundQueue.length = 0;
  }

  private handleMessage(data: unknown): void {
    if (this.cancelled) return;

    let message: CartesiaIncomingMessage;
    try {
      message = parseCartesiaIncomingMessage(data, this.contextId);
    } catch (error) {
      // error-policy:J3 provider WebSocket frames are untrusted input; malformed
      // data becomes an explicit provider error for the caller.
      this.emitProviderError({
        contextId: this.contextId,
        traceId: this.traceId,
        title: "Invalid Cartesia WebSocket message",
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof CartesiaSonicTtsError ? error.code : "PROVIDER_MESSAGE_INVALID",
      });
      this.socket.close(1011, "Invalid Cartesia provider message");
      return;
    }

    if (message.type === "chunk") {
      this.handleChunk(message);
      return;
    }
    if (message.type === "done") {
      this.handleDone(message);
      return;
    }
    if (message.type === "error") {
      this.handleProviderError(message);
    }
  }

  private handleChunk(message: Extract<CartesiaIncomingMessage, { type: "chunk" }>): void {
    if (!this.firstAudioEmitted) {
      this.firstAudioEmitted = true;
      const elapsedMs = Date.now() - this.startedAt;
      this.input.callbacks.onFirstAudio?.({
        contextId: message.context_id ?? this.contextId,
        traceId: this.traceId,
        elapsedMs,
      });
      this.emitMetric("cartesia_tts_first_audio", {
        contextId: message.context_id ?? this.contextId,
        elapsedMs,
      });
    }

    const sequence = ++this.frameSequence;
    const bytes = decodeBase64(message.data);
    this.input.callbacks.onAudioFrame?.({
      bytes,
      sequence,
      contextId: message.context_id ?? this.contextId,
      traceId: this.traceId,
      flushId: message.flush_id,
      statusCode: message.status_code,
      stepTimeMs: message.step_time,
    });
    this.emitMetric("cartesia_tts_audio_frame", {
      contextId: message.context_id ?? this.contextId,
      sequence,
      byteLength: bytes.byteLength,
      flushId: message.flush_id,
    });
  }

  private handleDone(message: Extract<CartesiaIncomingMessage, { type: "done" }>): void {
    this.completed = true;
    this.input.callbacks.onComplete?.({
      contextId: message.context_id ?? this.contextId,
      traceId: this.traceId,
      frameCount: this.frameSequence,
    });
    this.emitMetric("cartesia_tts_complete", {
      contextId: message.context_id ?? this.contextId,
      frameCount: this.frameSequence,
      statusCode: message.status_code,
    });
    this.socket.close(1000, "Cartesia context complete");
  }

  private handleProviderError(message: Extract<CartesiaIncomingMessage, { type: "error" }>): void {
    const event = {
      contextId: message.context_id ?? this.contextId,
      traceId: this.traceId,
      title: message.title ?? "Cartesia provider error",
      message: message.message ?? "Cartesia provider returned an error",
      code: message.error_code,
      statusCode: message.status_code,
      requestId: message.request_id,
      docUrl: message.doc_url,
    };
    this.emitProviderError(event);
    this.socket.close(1011, "Cartesia provider error");
  }

  private emitProviderError(event: CartesiaSonicProviderErrorEvent): void {
    if (this.providerErrorEmitted) return;
    this.providerErrorEmitted = true;
    this.input.callbacks.onProviderError?.(event);
    this.emitMetric("cartesia_tts_provider_error", {
      contextId: event.contextId,
      code: event.code,
      statusCode: event.statusCode,
      requestId: event.requestId,
    });
  }

  private rejectOpenedOnce(error: CartesiaSonicTtsError): void {
    if (this.openedSettled) return;
    this.openedSettled = true;
    this.rejectOpened(error);
  }

  private emitMetric(
    name: CartesiaSonicMetricEvent["name"],
    attributes: CartesiaSonicMetricEvent["attributes"],
  ): void {
    this.input.metrics?.({
      name,
      traceId: this.traceId,
      timestampMs: Date.now(),
      attributes: {
        provider: CARTESIA_SONIC_PROVIDER_ID,
        modelId: CARTESIA_SONIC_MODEL_ID,
        sampleRate: this.input.metadata.output.sampleRate,
        channels: this.input.metadata.output.channels,
        ...attributes,
      },
    });
  }
}

function buildCartesiaWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("cartesia_version", CARTESIA_API_VERSION);
  return url.toString();
}

function parseCartesiaIncomingMessage(data: unknown, contextId: string): CartesiaIncomingMessage {
  if (typeof data !== "string") {
    throw new CartesiaSonicTtsError(
      "Cartesia WebSocket message must be JSON text",
      "PROVIDER_MESSAGE_NOT_TEXT",
      { contextId, messageType: typeof data },
    );
  }
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed)) {
      throw new CartesiaSonicTtsError(
        "Cartesia WebSocket message is missing type",
        "PROVIDER_MESSAGE_INVALID",
        { contextId },
      );
    }
    return validateCartesiaIncomingMessage(parsed, contextId);
  } catch (error) {
    // error-policy:J3 provider WebSocket payload is untrusted input; malformed
    // frames are surfaced as explicit provider failures, never coerced.
    if (error instanceof CartesiaSonicTtsError) throw error;
    throw new CartesiaSonicTtsError(
      "Cartesia WebSocket message is not valid JSON",
      "PROVIDER_MESSAGE_INVALID_JSON",
      { contextId },
      error,
    );
  }
}

function validateCartesiaIncomingMessage(
  message: Record<string, unknown>,
  contextId: string,
): CartesiaIncomingMessage {
  if (typeof message.type !== "string") {
    throw new CartesiaSonicTtsError(
      "Cartesia WebSocket message is missing type",
      "PROVIDER_MESSAGE_INVALID",
      { contextId },
    );
  }

  switch (message.type) {
    case "chunk":
      assertRequiredBase64(message.data, contextId);
      return message as Extract<CartesiaIncomingMessage, { type: "chunk" }>;
    case "done":
      return message as Extract<CartesiaIncomingMessage, { type: "done" }>;
    case "flush_done":
      return message as Extract<CartesiaIncomingMessage, { type: "flush_done" }>;
    case "error":
      return message as Extract<CartesiaIncomingMessage, { type: "error" }>;
    case "timestamps":
    case "phoneme_timestamps":
      return message as Extract<
        CartesiaIncomingMessage,
        { type: "timestamps" | "phoneme_timestamps" }
      >;
    default:
      throw new CartesiaSonicTtsError(
        "Cartesia WebSocket message has unsupported type",
        "PROVIDER_MESSAGE_UNSUPPORTED_TYPE",
        { contextId, type: message.type },
      );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function assertRequiredBase64(value: unknown, contextId: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CartesiaSonicTtsError(
      "Cartesia chunk message is missing audio data",
      "PROVIDER_CHUNK_DATA_MISSING",
      { contextId },
    );
  }
  if (!isBase64(value)) {
    throw new CartesiaSonicTtsError(
      "Cartesia chunk message has invalid base64 audio data",
      "PROVIDER_CHUNK_DATA_INVALID_BASE64",
      { contextId },
    );
  }
}

function isBase64(value: string): boolean {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    atob(value);
    return true;
  } catch {
    // error-policy:J3 provider chunk data is untrusted input; invalid base64 is
    // translated into an explicit malformed-frame result by the caller.
    return false;
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function removeUndefinedFields<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined),
  ) as T;
}
