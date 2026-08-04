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
import { logger, ModelType } from "@elizaos/core";
import { decode, encode } from "@msgpack/msgpack";

export const FISH_AUDIO_TTS_WEBSOCKET_URL = "wss://api.fish.audio/v1/tts/live";
const DEFAULT_MODEL = "s2.1-pro";
const DEFAULT_SAMPLE_RATE = 24_000;
const DEFAULT_FORMAT = "pcm";
const DEFAULT_MIME_TYPE = "audio/pcm; codecs=pcm_s16le; rate=24000";
const TRUEY = new Set(["1", "true", "yes", "on"]);

type FishAudioModel = "s2.1" | "s2.1-pro";
type FishAudioFormat = "pcm";
type TtsInput =
  | string
  | (TextToSpeechParams & {
      model?: string;
      format?: FishAudioFormat;
      sampleRate?: number;
    });

interface FishAudioWebSocketLike {
  readonly readyState: number;
  binaryType?: BinaryType;
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

function getProcessEnv(): ProcessEnvLike {
  if (typeof process === "undefined") return {};
  return process.env as ProcessEnvLike;
}

function getSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting?.(key) ?? getProcessEnv()[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isEnabled(runtime: IAgentRuntime): boolean {
  return TRUEY.has(
    (getSetting(runtime, "ELIZA_TTS_FISH_ENABLED") ?? "").toLowerCase(),
  );
}

function resolveConfig(runtime: IAgentRuntime, input: TtsInput) {
  if (!isEnabled(runtime)) {
    throw new Error(
      "Fish Audio TTS is disabled; set ELIZA_TTS_FISH_ENABLED=true",
    );
  }
  const apiKey = getSetting(runtime, "FISH_AUDIO_API_KEY");
  if (!apiKey) throw new Error("FISH_AUDIO_API_KEY is required");
  const text = typeof input === "string" ? input : input.text;
  if (!text || text.trim().length === 0)
    throw new Error("TEXT_TO_SPEECH requires non-empty text");
  const voice = typeof input === "string" ? undefined : input.voice;
  const referenceId =
    voice ??
    getSetting(runtime, "FISH_AUDIO_REFERENCE_ID") ??
    getSetting(runtime, "FISH_AUDIO_VOICE_ID");
  if (!referenceId)
    throw new Error(
      "FISH_AUDIO_REFERENCE_ID or FISH_AUDIO_VOICE_ID is required",
    );
  const model = ((typeof input === "string" ? undefined : input.model) ??
    getSetting(runtime, "FISH_AUDIO_MODEL") ??
    DEFAULT_MODEL) as FishAudioModel;
  if (model !== "s2.1" && model !== "s2.1-pro")
    throw new Error(`Unsupported Fish Audio model: ${model}`);
  const format =
    (typeof input === "string" ? undefined : input.format) ??
    (getSetting(runtime, "FISH_AUDIO_FORMAT") as FishAudioFormat | undefined) ??
    DEFAULT_FORMAT;
  const sampleRate = Number(
    (typeof input === "string" ? undefined : input.sampleRate) ??
      getSetting(runtime, "FISH_AUDIO_SAMPLE_RATE") ??
      DEFAULT_SAMPLE_RATE,
  );
  if (format !== "pcm")
    throw new Error(`Unsupported Fish Audio format: ${format}`);
  if (sampleRate !== DEFAULT_SAMPLE_RATE)
    throw new Error("Fish Audio sampleRate must be 24000");
  return {
    apiKey,
    text,
    referenceId,
    model,
    format,
    sampleRate,
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
  const socket = openSocket(config.apiKey);
  socket.binaryType = "arraybuffer";

  const finish = () => {
    if (done) return;
    done = true;
    resolveBytes(concatBytes(bufferedChunks, totalBytes));
    while (waiters.length > 0) {
      waiters.shift()?.({ done: true, value: undefined });
    }
  };
  const fail = (error: unknown) => {
    failure = error;
    rejectBytes(error);
    finish();
  };
  const push = (chunk: Uint8Array) => {
    bufferedChunks.push(chunk);
    totalBytes += chunk.byteLength;
    const waiter = waiters.shift();
    if (waiter) {
      waiter({ done: false, value: chunk });
      return;
    }
    chunks.push(chunk);
  };

  socket.addEventListener("open", () => {
    socket.send(
      encode({
        event: "start",
        request: {
          text: "",
          reference_id: config.referenceId,
          format: "pcm",
          sample_rate: 24000,
          latency: "normal",
          model: config.model,
        },
      }),
    );
    socket.send(encode({ event: "text", text: config.text }));
    socket.send(encode({ event: "stop" }));
  });
  socket.addEventListener("message", (event) => {
    try {
      const frame = decodeFrame(event.data);
      const audio = frame.audio;
      if (audio instanceof Uint8Array) push(audio);
      if (frame.event === "finish") finish();
      if (frame.event === "error" || frame.error) {
        fail(
          new Error(
            String(frame.message ?? frame.error ?? "Fish Audio TTS failed"),
          ),
        );
      }
    } catch (error) {
      fail(error);
    }
  });
  socket.addEventListener("error", (event) =>
    fail(
      new Error(
        event.message ??
          (event.error instanceof Error
            ? event.error.message
            : "Fish Audio WebSocket error"),
      ),
    ),
  );
  socket.addEventListener("close", () => finish());
  config.signal?.addEventListener("abort", () => {
    fail(new Error("Fish Audio TTS aborted"));
    socket.close(1000, "aborted");
  });

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

function openSocket(apiKey: string): FishAudioWebSocketLike {
  const WebSocketCtor = (
    globalThis as {
      WebSocket?: new (
        url: string,
        protocolsOrOptions?:
          | string
          | string[]
          | { headers?: Record<string, string> },
        options?: { headers?: Record<string, string> },
      ) => FishAudioWebSocketLike;
    }
  ).WebSocket;
  if (!WebSocketCtor)
    throw new Error("WebSocket is not available for Fish Audio TTS");
  const options = { headers: { Authorization: `Bearer ${apiKey}` } };
  try {
    return new WebSocketCtor(FISH_AUDIO_TTS_WEBSOCKET_URL, undefined, options);
  } catch {
    // error-policy:J1 boundary translation — runtimes differ on whether WS
    // headers are accepted as the second or third constructor argument.
    return new WebSocketCtor(FISH_AUDIO_TTS_WEBSOCKET_URL, options);
  }
}

function decodeFrame(data: unknown): Record<string, unknown> {
  const frame =
    data instanceof ArrayBuffer
      ? decode(new Uint8Array(data))
      : ArrayBuffer.isView(data)
        ? decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
        : decode(data as Uint8Array);
  if (typeof frame !== "object" || frame === null)
    throw new Error("Fish Audio frame must be an object");
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
  },
  async init(_config, runtime) {
    if (!isEnabled(runtime)) {
      logger.info(
        "[Fish Audio] TEXT_TO_SPEECH registration skipped: ELIZA_TTS_FISH_ENABLED is off",
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
