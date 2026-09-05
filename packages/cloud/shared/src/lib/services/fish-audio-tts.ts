/**
 * Server-side Fish Audio realtime TTS adapter.
 *
 * The module owns Fish's public realtime WebSocket mapping for Eliza voice:
 * MessagePack request frames, streamed PCM downlink bytes, first-audio metrics,
 * queue bounds, and cancellation. Callers retain phrase aggregation, fallback
 * policy, playback, and billing responsibility.
 */

import { ElizaError } from "@elizaos/core/edge";
import { decode, encode } from "@msgpack/msgpack";

export const FISH_AUDIO_PROVIDER_ID = "fish-audio";
export const FISH_AUDIO_MODEL_S1 = "s1";
export const FISH_AUDIO_MODEL_S2_PRO = "s2-pro";
export const FISH_AUDIO_MODEL_S21_PRO = "s2.1-pro";
export const FISH_AUDIO_MODEL_S21_PRO_FREE = "s2.1-pro-free";
export const FISH_AUDIO_TTS_WEBSOCKET_URL = "wss://api.fish.audio/v1/tts/live";

const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_FORMAT = "pcm";
const DEFAULT_MODEL = FISH_AUDIO_MODEL_S21_PRO;
const DEFAULT_LATENCY = "balanced";
const DEFAULT_CHUNK_LENGTH = 100;
const DEFAULT_FIRST_AUDIO_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_QUEUED_FRAMES = 128;
const SUPPORTED_MODELS = new Set([
  FISH_AUDIO_MODEL_S1,
  FISH_AUDIO_MODEL_S2_PRO,
  FISH_AUDIO_MODEL_S21_PRO,
  FISH_AUDIO_MODEL_S21_PRO_FREE,
]);

export type FishAudioModel =
  | typeof FISH_AUDIO_MODEL_S1
  | typeof FISH_AUDIO_MODEL_S2_PRO
  | typeof FISH_AUDIO_MODEL_S21_PRO
  | typeof FISH_AUDIO_MODEL_S21_PRO_FREE;
export type FishAudioFormat = "pcm";

export interface FishAudioProviderMetadata {
  readonly provider: typeof FISH_AUDIO_PROVIDER_ID;
  readonly modelId: FishAudioModel;
  readonly transport: "websocket";
  readonly output: {
    readonly container: "raw" | "wav" | "mp3" | "opus";
    readonly encoding: "pcm_s16le" | "encoded";
    readonly sampleRate: number;
    readonly channels: number;
  };
}

export interface FishAudioAdapterConfig {
  readonly apiKey: string;
  readonly referenceId: string;
  readonly websocketFactory: FishAudioWebSocketFactory;
  readonly websocketUrl?: string;
  readonly model?: FishAudioModel;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly format?: FishAudioFormat;
  readonly latency?: "normal" | "balanced";
  readonly firstAudioTimeoutMs?: number;
  readonly maxQueuedFrames?: number;
  readonly metrics?: FishAudioMetricsHook;
  readonly now?: () => number;
}

export interface FishAudioMetricEvent {
  readonly name:
    | "fish_tts_ws_open"
    | "fish_tts_first_audio"
    | "fish_tts_audio_frame"
    | "fish_tts_complete"
    | "fish_tts_provider_error"
    | "fish_tts_cancelled"
    | "fish_tts_backpressure";
  readonly traceId?: string;
  readonly timestampMs: number;
  readonly attributes: Record<string, string | number | boolean | undefined>;
}

export type FishAudioMetricsHook = (event: FishAudioMetricEvent) => void;

export interface FishAudioStreamOptions {
  readonly contextId?: string;
  readonly traceId?: string;
  readonly firstAudioTimeoutMs?: number;
}

export interface FishAudioPhraseInput {
  readonly text: string;
  readonly continueContext: boolean;
  readonly flush?: boolean;
}

export interface FishAudioFirstAudioEvent {
  readonly contextId: string;
  readonly traceId?: string;
  readonly elapsedMs: number;
}

export interface FishAudioAudioFrameEvent {
  readonly bytes: Uint8Array;
  readonly sequence: number;
  readonly contextId: string;
  readonly traceId?: string;
}

export interface FishAudioCompleteEvent {
  readonly contextId: string;
  readonly traceId?: string;
  readonly frameCount: number;
}

export interface FishAudioProviderErrorEvent {
  readonly contextId: string;
  readonly traceId?: string;
  readonly title: string;
  readonly message: string;
  readonly code?: string;
  readonly statusCode?: number;
}

export interface FishAudioCancelledEvent {
  readonly contextId: string;
  readonly traceId?: string;
  readonly reason?: string;
}

export interface FishAudioStreamCallbacks {
  readonly onFirstAudio?: (event: FishAudioFirstAudioEvent) => void;
  readonly onAudioFrame?: (event: FishAudioAudioFrameEvent) => void;
  readonly onComplete?: (event: FishAudioCompleteEvent) => void;
  readonly onProviderError?: (event: FishAudioProviderErrorEvent) => void;
  readonly onCancelled?: (event: FishAudioCancelledEvent) => void;
}

export interface FishAudioWebSocketFactoryOptions {
  readonly headers: Record<string, string>;
}

export type FishAudioWebSocketFactory = (
  url: string,
  options: FishAudioWebSocketFactoryOptions,
) => FishAudioWebSocketLike;

export interface FishAudioWebSocketLike {
  readonly readyState: number;
  binaryType?: BinaryType;
  send(data: Uint8Array): void;
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

type FishOutgoingFrame =
  | {
      readonly event: "start";
      readonly request: {
        readonly text: "";
        readonly reference_id: string;
        readonly format: "pcm";
        readonly sample_rate: 16_000;
        readonly latency: "normal" | "balanced";
        readonly chunk_length: number;
      };
    }
  | {
      readonly event: "text";
      readonly text: string;
    }
  | { readonly event: "flush" }
  | { readonly event: "stop" };

interface FishIncomingFrame {
  readonly event?: string;
  readonly audio?: unknown;
  readonly error?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
  readonly reason?: unknown;
}

export class FishAudioTtsError extends ElizaError {
  override readonly name = "FishAudioTtsError";

  constructor(message: string, code: string, context?: Record<string, unknown>, cause?: unknown) {
    super(message, { code, context, cause });
  }
}

export class FishAudioTtsAdapter {
  readonly metadata: FishAudioProviderMetadata;

  private readonly config: NormalizedConfig;

  constructor(config: FishAudioAdapterConfig) {
    this.config = validateFishAudioConfig(config);
    this.metadata = {
      provider: FISH_AUDIO_PROVIDER_ID,
      modelId: this.config.model,
      transport: "websocket",
      output: {
        container: "raw",
        encoding: "pcm_s16le",
        sampleRate: this.config.sampleRate,
        channels: this.config.channels,
      },
    };
  }

  createStream(
    options: FishAudioStreamOptions,
    callbacks: FishAudioStreamCallbacks,
  ): FishAudioTtsStream {
    const firstAudioTimeoutMs = options.firstAudioTimeoutMs ?? this.config.firstAudioTimeoutMs;
    if (!Number.isFinite(firstAudioTimeoutMs) || firstAudioTimeoutMs <= 0) {
      throw new FishAudioTtsError(
        "Fish firstAudioTimeoutMs must be a positive finite number",
        "CONFIG_FIRST_AUDIO_TIMEOUT_INVALID",
        { firstAudioTimeoutMs },
      );
    }
    return new FishAudioTtsStream({
      ...this.config,
      contextId: options.contextId ?? crypto.randomUUID(),
      traceId: options.traceId,
      firstAudioTimeoutMs,
      callbacks,
    });
  }
}

interface NormalizedConfig {
  readonly apiKey: string;
  readonly referenceId: string;
  readonly websocketFactory: FishAudioWebSocketFactory;
  readonly websocketUrl: string;
  readonly model: FishAudioModel;
  readonly sampleRate: number;
  readonly channels: 1;
  readonly format: FishAudioFormat;
  readonly latency: "normal" | "balanced";
  readonly firstAudioTimeoutMs: number;
  readonly maxQueuedFrames: number;
  readonly metrics?: FishAudioMetricsHook;
  readonly now: () => number;
}

interface StreamConstructorInput extends NormalizedConfig {
  readonly contextId: string;
  readonly traceId?: string;
  readonly callbacks: FishAudioStreamCallbacks;
}

export class FishAudioTtsStream {
  readonly contextId: string;
  readonly traceId?: string;
  readonly opened: Promise<void>;
  readonly closed: Promise<void>;

  private readonly input: StreamConstructorInput;
  private readonly socket: FishAudioWebSocketLike;
  private readonly outboundQueue: Uint8Array[] = [];
  private frameSequence = 0;
  private cancelled = false;
  private completed = false;
  private socketOpened = false;
  private openedSettled = false;
  private firstAudioEmitted = false;
  private providerErrorEmitted = false;
  private firstAudioTimer: ReturnType<typeof setTimeout> | null = null;
  private firstTextSubmittedAtMs: number | null = null;
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
    this.socket = input.websocketFactory(input.websocketUrl, {
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        model: input.model,
      },
    });
    this.socket.binaryType = "arraybuffer";
    this.attachSocketListeners();
  }

  sendPhrase(phrase: FishAudioPhraseInput): void {
    if (this.cancelled) {
      throw new FishAudioTtsError(
        "Cannot send a Fish phrase after cancellation",
        "STREAM_CANCELLED",
        {
          contextId: this.contextId,
        },
      );
    }
    if (this.completed) {
      throw new FishAudioTtsError(
        "Cannot send a Fish phrase after completion",
        "STREAM_COMPLETED",
        {
          contextId: this.contextId,
        },
      );
    }
    if (this.providerErrorEmitted) {
      throw new FishAudioTtsError(
        "Cannot send a Fish phrase after provider failure",
        "STREAM_FAILED",
        {
          contextId: this.contextId,
        },
      );
    }

    if (!this.firstAudioTimer && phrase.text.trim().length > 0) {
      this.startFirstAudioTimer();
    }
    this.sendOrQueue({
      event: "text",
      text: phrase.text,
    });
    if (phrase.flush) this.sendOrQueue({ event: "flush" });
    if (!phrase.continueContext) this.sendOrQueue({ event: "stop" });
  }

  cancel(reason?: string): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.clearFirstAudioTimer();
    this.discardQueuedOutbound();
    this.rejectOpenedOnce(
      new FishAudioTtsError("Fish WebSocket closed during cancellation", "STREAM_CANCELLED", {
        contextId: this.contextId,
      }),
    );
    this.input.callbacks.onCancelled?.({
      contextId: this.contextId,
      traceId: this.traceId,
      reason,
    });
    this.emitMetric("fish_tts_cancelled", { contextId: this.contextId, reason });
    this.socket.close(1000, reason);
  }

  private attachSocketListeners(): void {
    this.socket.addEventListener("open", () => {
      if (this.cancelled || this.providerErrorEmitted) {
        this.discardQueuedOutbound();
        return;
      }
      this.socketOpened = true;
      this.openedSettled = true;
      this.resolveOpened();
      this.socket.send(
        encode({
          event: "start",
          request: {
            text: "",
            reference_id: this.input.referenceId,
            format: "pcm",
            sample_rate: 16_000,
            latency: this.input.latency,
            chunk_length: DEFAULT_CHUNK_LENGTH,
          },
        } satisfies FishOutgoingFrame),
      );
      this.flushQueuedOutbound();
      this.emitMetric("fish_tts_ws_open", { contextId: this.contextId });
    });
    this.socket.addEventListener("message", (event) => this.handleMessage(event.data));
    this.socket.addEventListener("error", (event) => {
      if (this.cancelled) return;
      this.emitProviderError({
        contextId: this.contextId,
        traceId: this.traceId,
        title: "Fish WebSocket error",
        message:
          event.message ?? (event.error instanceof Error ? event.error.message : "WebSocket error"),
        code: "websocket_error",
      });
      this.rejectOpenedOnce(new FishAudioTtsError("Fish WebSocket error", "websocket_error"));
      this.socket.close(1011, "Fish WebSocket error");
    });
    this.socket.addEventListener("close", (event) => {
      this.clearFirstAudioTimer();
      if (!this.cancelled && !this.providerErrorEmitted && !this.completed) {
        const beforeOpen = !this.socketOpened;
        const code = beforeOpen ? "websocket_closed_before_open" : "websocket_error";
        const phase = beforeOpen
          ? "before opening"
          : this.firstAudioEmitted
            ? "before completion"
            : "before first audio";
        const message = event.reason
          ? `Fish WebSocket closed ${phase}: ${event.reason}`
          : `Fish WebSocket closed ${phase}`;
        this.emitProviderError({
          contextId: this.contextId,
          traceId: this.traceId,
          title: `Fish WebSocket closed ${phase}`,
          message,
          code,
          statusCode: event.code,
        });
        if (beforeOpen) this.rejectOpenedOnce(new FishAudioTtsError(message, code));
      }
      this.resolveClosed();
    });
  }

  private sendOrQueue(frame: FishOutgoingFrame): void {
    const data = encode(removeUndefinedFields(frame));
    if (this.socket.readyState === 1 && this.socketOpened) {
      this.socket.send(data);
      return;
    }
    if (this.outboundQueue.length >= this.input.maxQueuedFrames) {
      this.emitMetric("fish_tts_backpressure", {
        contextId: this.contextId,
        queuedFrames: this.outboundQueue.length,
      });
      throw new FishAudioTtsError("Fish outbound queue exceeded", "BACKPRESSURE", {
        contextId: this.contextId,
        maxQueuedFrames: this.input.maxQueuedFrames,
      });
    }
    this.outboundQueue.push(data);
  }

  private flushQueuedOutbound(): void {
    while (this.outboundQueue.length > 0) {
      const data = this.outboundQueue.shift();
      if (!data) return;
      this.socket.send(data);
    }
  }

  private discardQueuedOutbound(): void {
    this.outboundQueue.length = 0;
  }

  private handleMessage(data: unknown): void {
    if (this.cancelled) return;
    let frame: FishIncomingFrame;
    try {
      frame = decodeFishFrame(data);
    } catch (error) {
      // error-policy:J3 provider WebSocket frames are untrusted input; malformed
      // MessagePack becomes an explicit provider error for the caller.
      this.emitProviderError({
        contextId: this.contextId,
        traceId: this.traceId,
        title: "Invalid Fish WebSocket message",
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof FishAudioTtsError ? error.code : "PROVIDER_MESSAGE_INVALID",
      });
      this.socket.close(1011, "Invalid Fish provider message");
      return;
    }

    if (frame.event === "error" || frame.error || frame.code) {
      this.emitProviderError({
        contextId: this.contextId,
        traceId: this.traceId,
        title: "Fish provider error",
        message:
          typeof frame.message === "string" ? frame.message : "Fish provider returned an error",
        code: typeof frame.code === "string" ? frame.code : undefined,
      });
      this.socket.close(1011, "Fish provider error");
      return;
    }

    const bytes = extractAudioBytes(frame);
    if (bytes) {
      this.handleAudio(bytes);
      return;
    }

    if (frame.event === "finish") {
      if (frame.reason === "error") {
        this.emitProviderError({
          contextId: this.contextId,
          traceId: this.traceId,
          title: "Fish provider failed to finish synthesis",
          message:
            typeof frame.message === "string"
              ? frame.message
              : "Fish provider finished synthesis with an error",
          code: typeof frame.code === "string" ? frame.code : "provider_finish_error",
        });
        this.socket.close(1011, "Fish provider finish error");
        return;
      }
      this.completed = true;
      this.clearFirstAudioTimer();
      this.input.callbacks.onComplete?.({
        contextId: this.contextId,
        traceId: this.traceId,
        frameCount: this.frameSequence,
      });
      this.emitMetric("fish_tts_complete", {
        contextId: this.contextId,
        frameCount: this.frameSequence,
      });
      this.socket.close(1000, "Fish context complete");
    }
  }

  private handleAudio(bytes: Uint8Array): void {
    if (!this.firstAudioEmitted) {
      if (this.firstTextSubmittedAtMs === null) {
        this.emitProviderError({
          contextId: this.contextId,
          traceId: this.traceId,
          title: "Fish provider sent audio before text",
          message: "Fish emitted audio before the first non-empty text submission",
          code: "provider_audio_before_text",
        });
        this.socket.close(1011, "Fish audio before text");
        return;
      }
      this.firstAudioEmitted = true;
      this.clearFirstAudioTimer();
      const elapsedMs = this.input.now() - this.firstTextSubmittedAtMs;
      this.input.callbacks.onFirstAudio?.({
        contextId: this.contextId,
        traceId: this.traceId,
        elapsedMs,
      });
      this.emitMetric("fish_tts_first_audio", { contextId: this.contextId, elapsedMs });
    }
    const sequence = ++this.frameSequence;
    this.input.callbacks.onAudioFrame?.({
      bytes,
      sequence,
      contextId: this.contextId,
      traceId: this.traceId,
    });
    this.emitMetric("fish_tts_audio_frame", {
      contextId: this.contextId,
      sequence,
      byteLength: bytes.byteLength,
    });
  }

  private emitProviderError(event: FishAudioProviderErrorEvent): void {
    if (this.providerErrorEmitted) return;
    this.providerErrorEmitted = true;
    this.clearFirstAudioTimer();
    this.discardQueuedOutbound();
    this.input.callbacks.onProviderError?.(event);
    this.emitMetric("fish_tts_provider_error", {
      contextId: event.contextId,
      code: event.code,
      statusCode: event.statusCode,
    });
  }

  private startFirstAudioTimer(): void {
    if (this.firstAudioTimer) return;
    this.firstTextSubmittedAtMs = this.input.now();
    this.firstAudioTimer = setTimeout(() => {
      if (this.cancelled || this.firstAudioEmitted || this.completed || this.providerErrorEmitted)
        return;
      this.emitProviderError({
        contextId: this.contextId,
        traceId: this.traceId,
        title: "Fish first-audio timeout",
        message: "Fish did not produce audio before the first-audio timeout",
        code: "first_audio_timeout",
      });
      this.socket.close(1013, "Fish first-audio timeout");
    }, this.input.firstAudioTimeoutMs);
  }

  private clearFirstAudioTimer(): void {
    if (!this.firstAudioTimer) return;
    clearTimeout(this.firstAudioTimer);
    this.firstAudioTimer = null;
  }

  private rejectOpenedOnce(error: FishAudioTtsError): void {
    if (this.openedSettled) return;
    this.openedSettled = true;
    this.rejectOpened(error);
  }

  private emitMetric(
    name: FishAudioMetricEvent["name"],
    attributes: FishAudioMetricEvent["attributes"],
  ): void {
    this.input.metrics?.({
      name,
      traceId: this.traceId,
      timestampMs: this.input.now(),
      attributes: {
        provider: FISH_AUDIO_PROVIDER_ID,
        modelId: this.input.model,
        sampleRate: this.input.sampleRate,
        channels: this.input.channels,
        ...attributes,
      },
    });
  }
}

function validateFishAudioConfig(config: FishAudioAdapterConfig): NormalizedConfig {
  const apiKey = config.apiKey.trim();
  if (!apiKey)
    throw new FishAudioTtsError("FISH_AUDIO_API_KEY is required", "CONFIG_API_KEY_MISSING");

  const referenceId = config.referenceId.trim();
  if (!referenceId) {
    throw new FishAudioTtsError("Fish referenceId is required", "CONFIG_REFERENCE_ID_MISSING");
  }

  const model = config.model ?? DEFAULT_MODEL;
  if (!SUPPORTED_MODELS.has(model)) {
    throw new FishAudioTtsError("Fish model is not supported", "CONFIG_MODEL_INVALID", { model });
  }

  const sampleRate = config.sampleRate ?? DEFAULT_SAMPLE_RATE;
  if (sampleRate !== DEFAULT_SAMPLE_RATE) {
    throw new FishAudioTtsError(
      "Fish realtime sampleRate must be 16000 for the voice-session PCM contract",
      "CONFIG_SAMPLE_RATE_INVALID",
      {
        sampleRate,
      },
    );
  }

  const channels = config.channels ?? DEFAULT_CHANNELS;
  if (channels !== DEFAULT_CHANNELS) {
    throw new FishAudioTtsError(
      "Fish realtime output is pinned to mono PCM",
      "CONFIG_CHANNELS_INVALID",
      {
        channels,
      },
    );
  }

  const format = config.format ?? DEFAULT_FORMAT;
  if (format !== "pcm") {
    throw new FishAudioTtsError("Fish format is not supported", "CONFIG_FORMAT_INVALID", {
      format,
    });
  }

  const latency = config.latency ?? DEFAULT_LATENCY;
  if (latency !== "normal" && latency !== "balanced") {
    throw new FishAudioTtsError("Fish latency is not supported", "CONFIG_LATENCY_INVALID", {
      latency,
    });
  }

  const firstAudioTimeoutMs = config.firstAudioTimeoutMs ?? DEFAULT_FIRST_AUDIO_TIMEOUT_MS;
  if (!Number.isFinite(firstAudioTimeoutMs) || firstAudioTimeoutMs <= 0) {
    throw new FishAudioTtsError(
      "Fish firstAudioTimeoutMs must be a positive finite number",
      "CONFIG_FIRST_AUDIO_TIMEOUT_INVALID",
      { firstAudioTimeoutMs },
    );
  }

  const maxQueuedFrames = config.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES;
  if (!Number.isInteger(maxQueuedFrames) || maxQueuedFrames <= 0) {
    throw new FishAudioTtsError(
      "Fish maxQueuedFrames must be a positive integer",
      "CONFIG_MAX_QUEUED_FRAMES_INVALID",
      { maxQueuedFrames },
    );
  }

  return {
    apiKey,
    referenceId,
    websocketFactory: config.websocketFactory,
    websocketUrl: config.websocketUrl ?? FISH_AUDIO_TTS_WEBSOCKET_URL,
    model,
    sampleRate,
    channels: DEFAULT_CHANNELS,
    format,
    latency,
    firstAudioTimeoutMs,
    maxQueuedFrames,
    metrics: config.metrics,
    now: config.now ?? Date.now,
  };
}

function decodeFishFrame(data: unknown): FishIncomingFrame {
  if (data instanceof Uint8Array) return ensureFishFrame(decode(data));
  if (data instanceof ArrayBuffer) return ensureFishFrame(decode(new Uint8Array(data)));
  if (ArrayBuffer.isView(data)) {
    return ensureFishFrame(decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
  }
  throw new FishAudioTtsError("Fish frame must be MessagePack bytes", "PROVIDER_MESSAGE_INVALID");
}

function ensureFishFrame(value: unknown): FishIncomingFrame {
  if (typeof value !== "object" || value === null) {
    throw new FishAudioTtsError("Fish frame must decode to an object", "PROVIDER_MESSAGE_INVALID");
  }
  return value as FishIncomingFrame;
}

function extractAudioBytes(frame: FishIncomingFrame): Uint8Array | null {
  const audio = frame.audio;
  if (audio instanceof Uint8Array) return audio;
  if (audio instanceof ArrayBuffer) return new Uint8Array(audio);
  if (ArrayBuffer.isView(audio))
    return new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
  return null;
}

function removeUndefinedFields(value: FishOutgoingFrame): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
