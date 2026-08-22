/**
 * Registers Fish Audio as an elizaOS text-to-speech model provider.
 *
 * The handler uses Fish's public realtime WebSocket endpoint with MessagePack
 * frames. It returns an AudioStreamResult only when callers explicitly pass
 * `audioStream: true`; otherwise it buffers the streamed PCM bytes for the
 * legacy TEXT_TO_SPEECH result shape.
 */

import type {
  AudioStreamResult,
  IAgentRuntime,
  Plugin,
  ProcessEnvLike,
  TextToSpeechParams,
} from "@elizaos/core";
import { ElizaError, logger, ModelType } from "@elizaos/core";
import { decode, encode } from "@msgpack/msgpack";

export const FISH_AUDIO_TTS_WEBSOCKET_URL = "wss://api.fish.audio/v1/tts/live";
const DEFAULT_MODEL = "s2.1-pro";
const DEFAULT_SAMPLE_RATE = 24_000;
const DEFAULT_FORMAT = "pcm";
const DEFAULT_LATENCY = "balanced";
const DEFAULT_CHUNK_LENGTH = 100;
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_SYNTHESIS_TIMEOUT_MS = 120_000;
const MAX_SYNTHESIS_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_MIME_TYPE = "audio/pcm; codecs=pcm_s16le; rate=24000";
const TRUEY = new Set(["1", "true", "yes", "on"]);

type FishAudioModel = "s1" | "s2-pro" | "s2.1-pro" | "s2.1-pro-free";
type FishAudioFormat = "pcm";
type TtsInput =
  | string
  | (TextToSpeechParams & {
      model?: string;
      format?: FishAudioFormat;
      sampleRate?: number;
      maxBufferBytes?: number;
      synthesisTimeoutMs?: number;
    });

export interface FishAudioFailureClassification {
  category:
    | "auth"
    | "rate_limit"
    | "timeout"
    | "cancelled"
    | "provider"
    | "transport"
    | "invalid_response"
    | "configuration";
  retryable: boolean;
}

/** Classifies Fish failures for bounded caller-owned retry policy. */
export function classifyFishAudioFailure(
  error: unknown,
): FishAudioFailureClassification {
  const code = error instanceof ElizaError ? error.code : "";
  if (code === "FISH_AUDIO_AUTH_FAILED") {
    return { category: "auth", retryable: false };
  }
  if (code === "FISH_AUDIO_RATE_LIMITED") {
    return { category: "rate_limit", retryable: true };
  }
  if (code === "FISH_AUDIO_SYNTHESIS_TIMEOUT") {
    return { category: "timeout", retryable: true };
  }
  if (code === "FISH_AUDIO_STREAM_ABORTED") {
    return { category: "cancelled", retryable: false };
  }
  if (code === "FISH_AUDIO_PROVIDER_MESSAGE_INVALID") {
    return { category: "invalid_response", retryable: false };
  }
  if (
    code === "FISH_AUDIO_WEBSOCKET_ERROR" ||
    code === "FISH_AUDIO_WEBSOCKET_CLOSED_EARLY"
  ) {
    return { category: "transport", retryable: true };
  }
  if (code.startsWith("FISH_AUDIO_PROVIDER_")) {
    return { category: "provider", retryable: false };
  }
  return { category: "configuration", retryable: false };
}

interface FishAudioWebSocketLike {
  readonly readyState: number;
  binaryType?: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
  addEventListener(
    type: "error",
    listener: (event: {
      readonly message?: string;
      readonly error?: unknown;
    }) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: {
      readonly code?: number;
      readonly reason?: string;
    }) => void,
  ): void;
}

interface FishAudioWebSocketFactoryOptions {
  readonly headers: Record<string, string>;
}

type FishAudioWebSocketFactory = (
  url: string,
  options: FishAudioWebSocketFactoryOptions,
) => FishAudioWebSocketLike;

let configuredWebSocketFactory: FishAudioWebSocketFactory | undefined;

/** @internal Configures the platform transport used by package entrypoints. */
export function configureFishAudioWebSocketFactory(
  factory: FishAudioWebSocketFactory | undefined,
): void {
  configuredWebSocketFactory = factory;
}

function getProcessEnv(): ProcessEnvLike {
  if (typeof process === "undefined") return {};
  return process.env as ProcessEnvLike;
}

function getSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting?.(key) ?? getProcessEnv()[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRequested(runtime: IAgentRuntime): boolean {
  return TRUEY.has(
    (getSetting(runtime, "ELIZA_TTS_FISH_ENABLED") ?? "").toLowerCase(),
  );
}

function isDataGovernanceApproved(runtime: IAgentRuntime): boolean {
  return TRUEY.has(
    (
      getSetting(runtime, "FISH_AUDIO_DATA_GOVERNANCE_APPROVED") ?? ""
    ).toLowerCase(),
  );
}

function resolveConfig(runtime: IAgentRuntime, input: TtsInput) {
  if (!isRequested(runtime)) {
    throw new ElizaError(
      "Fish Audio TTS is disabled; set ELIZA_TTS_FISH_ENABLED=true",
      { code: "FISH_AUDIO_DISABLED" },
    );
  }
  if (!isDataGovernanceApproved(runtime)) {
    throw new ElizaError(
      "Fish Audio TTS is unavailable until an operator approves its data-governance policy",
      { code: "FISH_AUDIO_DATA_GOVERNANCE_NOT_APPROVED" },
    );
  }
  const apiKey = getSetting(runtime, "FISH_AUDIO_API_KEY");
  if (!apiKey) {
    throw new ElizaError("FISH_AUDIO_API_KEY is required", {
      code: "FISH_AUDIO_API_KEY_MISSING",
    });
  }
  const text = typeof input === "string" ? input : input.text;
  if (!text || text.trim().length === 0) {
    throw new ElizaError("TEXT_TO_SPEECH requires non-empty text", {
      code: "FISH_AUDIO_TEXT_EMPTY",
    });
  }
  const voice = typeof input === "string" ? undefined : input.voice;
  const referenceId =
    voice ??
    getSetting(runtime, "FISH_AUDIO_REFERENCE_ID") ??
    getSetting(runtime, "FISH_AUDIO_VOICE_ID");
  if (!referenceId)
    throw new ElizaError(
      "FISH_AUDIO_REFERENCE_ID or FISH_AUDIO_VOICE_ID is required",
      { code: "FISH_AUDIO_REFERENCE_ID_MISSING" },
    );
  const model = ((typeof input === "string" ? undefined : input.model) ??
    getSetting(runtime, "FISH_AUDIO_MODEL") ??
    DEFAULT_MODEL) as FishAudioModel;
  if (
    model !== "s1" &&
    model !== "s2-pro" &&
    model !== "s2.1-pro" &&
    model !== "s2.1-pro-free"
  )
    throw new ElizaError(`Unsupported Fish Audio model: ${model}`, {
      code: "FISH_AUDIO_MODEL_INVALID",
      context: { model },
    });
  const format =
    (typeof input === "string" ? undefined : input.format) ??
    (getSetting(runtime, "FISH_AUDIO_FORMAT") as FishAudioFormat | undefined) ??
    DEFAULT_FORMAT;
  const sampleRate = Number(
    (typeof input === "string" ? undefined : input.sampleRate) ??
      getSetting(runtime, "FISH_AUDIO_SAMPLE_RATE") ??
      DEFAULT_SAMPLE_RATE,
  );
  if (format !== "pcm") {
    throw new ElizaError(`Unsupported Fish Audio format: ${format}`, {
      code: "FISH_AUDIO_FORMAT_INVALID",
      context: { format },
    });
  }
  if (sampleRate !== DEFAULT_SAMPLE_RATE) {
    throw new ElizaError("Fish Audio sampleRate must be 24000", {
      code: "FISH_AUDIO_SAMPLE_RATE_INVALID",
      context: { sampleRate },
    });
  }
  const maxBufferBytes = Number(
    (typeof input === "string" ? undefined : input.maxBufferBytes) ??
      getSetting(runtime, "FISH_AUDIO_MAX_BUFFER_BYTES") ??
      DEFAULT_MAX_BUFFER_BYTES,
  );
  if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes <= 0) {
    throw new ElizaError(
      "Fish Audio maxBufferBytes must be a positive integer",
      {
        code: "FISH_AUDIO_MAX_BUFFER_BYTES_INVALID",
        context: { maxBufferBytes },
      },
    );
  }
  const synthesisTimeoutMs = Number(
    (typeof input === "string" ? undefined : input.synthesisTimeoutMs) ??
      getSetting(runtime, "FISH_AUDIO_SYNTHESIS_TIMEOUT_MS") ??
      DEFAULT_SYNTHESIS_TIMEOUT_MS,
  );
  if (
    !Number.isSafeInteger(synthesisTimeoutMs) ||
    synthesisTimeoutMs <= 0 ||
    synthesisTimeoutMs > MAX_SYNTHESIS_TIMEOUT_MS
  ) {
    throw new ElizaError(
      "Fish Audio synthesisTimeoutMs must be a positive integer",
      {
        code: "FISH_AUDIO_SYNTHESIS_TIMEOUT_INVALID",
        context: { synthesisTimeoutMs },
      },
    );
  }
  return {
    apiKey,
    text,
    referenceId,
    model,
    format,
    sampleRate,
    maxBufferBytes,
    synthesisTimeoutMs,
    audioStream: typeof input !== "string" && input.audioStream === true,
    signal: typeof input === "string" ? undefined : input.signal,
  };
}

export async function handleFishAudioTextToSpeech(
  runtime: IAgentRuntime,
  input: TtsInput,
): Promise<Uint8Array | AudioStreamResult> {
  const config = resolveConfig(runtime, input);
  const stream = createFishAudioStream(config);
  if (config.audioStream) return stream;
  return stream.bytes;
}

function createFishAudioStream(
  config: ReturnType<typeof resolveConfig>,
): AudioStreamResult {
  const chunks: Uint8Array[] = [];
  const bufferedChunks: Uint8Array[] = [];
  const waiters: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  let done = false;
  let failure: unknown;
  let totalBytes = 0;
  let resolveBytes!: (bytes: Uint8Array) => void;
  let rejectBytes!: (error: unknown) => void;
  const bytes = new Promise<Uint8Array>((resolve, reject) => {
    resolveBytes = resolve;
    rejectBytes = reject;
  });
  const socket = openSocket(config.apiKey, config.model);
  socket.binaryType = "arraybuffer";
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let unlistenAbort: (() => void) | undefined;

  const finish = () => {
    if (done) return;
    done = true;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    unlistenAbort?.();
    socket.close(1000, "synthesis complete");
    resolveBytes(concatBytes(bufferedChunks, totalBytes));
    while (waiters.length > 0) {
      waiters.shift()?.({ done: true, value: undefined });
    }
  };
  const fail = (
    error: unknown,
    closeCode = 1011,
    closeReason = "synthesis failed",
  ) => {
    if (done) return;
    done = true;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    unlistenAbort?.();
    socket.close(closeCode, closeReason);
    failure = error;
    rejectBytes(error);
    while (waiters.length > 0) {
      waiters.shift()?.({ done: true, value: undefined });
    }
  };
  const push = (chunk: Uint8Array) => {
    if (done) return;
    if (chunk.byteLength > config.maxBufferBytes - totalBytes) {
      fail(
        new ElizaError("Fish Audio TTS exceeded the buffered audio limit", {
          code: "FISH_AUDIO_MAX_BUFFER_BYTES_EXCEEDED",
          context: {
            maxBufferBytes: config.maxBufferBytes,
            receivedBytes: totalBytes + chunk.byteLength,
          },
        }),
        1009,
        "audio limit exceeded",
      );
      return;
    }
    bufferedChunks.push(chunk);
    totalBytes += chunk.byteLength;
    const waiter = waiters.shift();
    if (waiter) {
      waiter({ done: false, value: chunk });
      return;
    }
    chunks.push(chunk);
  };
  deadlineTimer = setTimeout(() => {
    fail(
      new ElizaError("Fish Audio TTS exceeded the synthesis deadline", {
        code: "FISH_AUDIO_SYNTHESIS_TIMEOUT",
        context: { synthesisTimeoutMs: config.synthesisTimeoutMs },
      }),
      1013,
      "synthesis timeout",
    );
  }, config.synthesisTimeoutMs);

  socket.addEventListener("open", () => {
    socket.send(
      encode({
        event: "start",
        request: {
          text: "",
          reference_id: config.referenceId,
          format: "pcm",
          sample_rate: 24000,
          latency: DEFAULT_LATENCY,
          chunk_length: DEFAULT_CHUNK_LENGTH,
        },
      }),
    );
    socket.send(encode({ event: "text", text: config.text }));
    socket.send(encode({ event: "flush" }));
    socket.send(encode({ event: "stop" }));
  });
  socket.addEventListener("message", (event) => {
    try {
      const frame = decodeFrame(event.data);
      const audio = frame.audio;
      if (audio instanceof Uint8Array) push(audio);
      if (frame.event === "finish") {
        if (frame.reason === "error") {
          fail(
            new ElizaError(
              String(
                frame.message ?? "Fish Audio TTS failed to finish synthesis",
              ),
              { code: "FISH_AUDIO_PROVIDER_FINISH_ERROR" },
            ),
          );
        } else {
          finish();
        }
      }
      if (frame.event === "error" || frame.error) {
        fail(
          new ElizaError(
            String(frame.message ?? frame.error ?? "Fish Audio TTS failed"),
            { code: "FISH_AUDIO_PROVIDER_ERROR" },
          ),
        );
      }
    } catch (error) {
      // error-policy:J1 provider frame handling is the transport boundary;
      // decoded provider failures reject the model result explicitly.
      fail(error);
    }
  });
  socket.addEventListener("error", (event) => {
    const message =
      event.message ??
      (event.error instanceof Error
        ? event.error.message
        : "Fish Audio WebSocket error");
    const statusCode = /\b(401|429)\b/.exec(message)?.[1];
    const code =
      statusCode === "401"
        ? "FISH_AUDIO_AUTH_FAILED"
        : statusCode === "429"
          ? "FISH_AUDIO_RATE_LIMITED"
          : "FISH_AUDIO_WEBSOCKET_ERROR";
    fail(
      new ElizaError(message, {
        code,
        cause: event.error,
        severity: statusCode === "401" ? "fatal" : "ephemeral",
        context: {
          retryable: statusCode !== "401",
          ...(statusCode ? { statusCode: Number(statusCode) } : {}),
        },
      }),
    );
  });
  socket.addEventListener("close", (event) => {
    if (done) return;
    const detail = event.reason ? `: ${event.reason}` : "";
    fail(
      new ElizaError(`Fish Audio WebSocket closed before finish${detail}`, {
        code: "FISH_AUDIO_WEBSOCKET_CLOSED_EARLY",
        context: { statusCode: event.code, reason: event.reason },
      }),
    );
  });
  const abort = () => {
    fail(
      new ElizaError("Fish Audio TTS aborted", {
        code: "FISH_AUDIO_STREAM_ABORTED",
      }),
      1000,
      "aborted",
    );
  };
  if (config.signal?.aborted) {
    abort();
  } else if (config.signal) {
    config.signal.addEventListener("abort", abort, { once: true });
    unlistenAbort = () => config.signal?.removeEventListener("abort", abort);
  }

  const audioStream: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (failure) return Promise.reject(failure);
          const chunk = chunks.shift();
          if (chunk) return Promise.resolve({ done: false, value: chunk });
          if (done) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve, reject) => {
            waiters.push((result) =>
              failure ? reject(failure) : resolve(result),
            );
          });
        },
      };
    },
  };
  return {
    audioStream,
    bytes,
    mimeType: mimeTypeFor(config.format, config.sampleRate),
  };
}

function openSocket(
  apiKey: string,
  model: FishAudioModel,
): FishAudioWebSocketLike {
  const options = {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      model,
    },
  };
  if (configuredWebSocketFactory) {
    return configuredWebSocketFactory(FISH_AUDIO_TTS_WEBSOCKET_URL, options);
  }
  throw new ElizaError(
    "Fish Audio requires the authenticated platform WebSocket transport",
    { code: "FISH_AUDIO_WEBSOCKET_UNAVAILABLE" },
  );
}

function decodeFrame(data: unknown): Record<string, unknown> {
  let frame: unknown;
  try {
    frame =
      data instanceof ArrayBuffer
        ? decode(new Uint8Array(data))
        : ArrayBuffer.isView(data)
          ? decode(
              new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
            )
          : decode(data as Uint8Array);
  } catch (error) {
    // error-policy:J1 malformed provider bytes are translated at the transport
    // boundary and never reach callers as an unclassified decoder exception.
    throw new ElizaError("Fish Audio returned an invalid MessagePack frame", {
      code: "FISH_AUDIO_PROVIDER_MESSAGE_INVALID",
      cause: error,
      severity: "fatal",
    });
  }
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    throw new ElizaError("Fish Audio frame must be an object", {
      code: "FISH_AUDIO_PROVIDER_MESSAGE_INVALID",
    });
  }
  return frame as Record<string, unknown>;
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function mimeTypeFor(format: FishAudioFormat, sampleRate: number): string {
  if (format === "pcm")
    return `audio/pcm; codecs=pcm_s16le; rate=${sampleRate}`;
  return DEFAULT_MIME_TYPE;
}

const env = getProcessEnv();

export const fishAudioPlugin: Plugin = {
  name: "fish-audio",
  description: "Fish Audio realtime text-to-speech provider",
  autoEnable: { envKeys: ["ELIZA_TTS_FISH_ENABLED", "FISH_AUDIO_API_KEY"] },
  config: {
    ELIZA_TTS_FISH_ENABLED: env.ELIZA_TTS_FISH_ENABLED ?? null,
    FISH_AUDIO_API_KEY: env.FISH_AUDIO_API_KEY ?? null,
    FISH_AUDIO_MODEL: env.FISH_AUDIO_MODEL ?? null,
    FISH_AUDIO_REFERENCE_ID: env.FISH_AUDIO_REFERENCE_ID ?? null,
    FISH_AUDIO_VOICE_ID: env.FISH_AUDIO_VOICE_ID ?? null,
    FISH_AUDIO_FORMAT: env.FISH_AUDIO_FORMAT ?? null,
    FISH_AUDIO_SAMPLE_RATE: env.FISH_AUDIO_SAMPLE_RATE ?? null,
    FISH_AUDIO_DATA_GOVERNANCE_APPROVED:
      env.FISH_AUDIO_DATA_GOVERNANCE_APPROVED ?? null,
    FISH_AUDIO_MAX_BUFFER_BYTES: env.FISH_AUDIO_MAX_BUFFER_BYTES ?? null,
    FISH_AUDIO_SYNTHESIS_TIMEOUT_MS:
      env.FISH_AUDIO_SYNTHESIS_TIMEOUT_MS ?? null,
  },
  async init(_config, runtime) {
    if (!isRequested(runtime)) {
      logger.info(
        "[Fish Audio] TEXT_TO_SPEECH registration skipped: ELIZA_TTS_FISH_ENABLED is off",
      );
      return;
    }
    if (!isDataGovernanceApproved(runtime)) {
      logger.warn(
        "[Fish Audio] TEXT_TO_SPEECH registration skipped: data-governance approval is absent",
      );
      return;
    }
    runtime.registerModel(
      ModelType.TEXT_TO_SPEECH,
      handleFishAudioTextToSpeech as unknown as Parameters<
        IAgentRuntime["registerModel"]
      >[1],
      fishAudioPlugin.name,
      fishAudioPlugin.priority,
    );
  },
};

export default fishAudioPlugin;
