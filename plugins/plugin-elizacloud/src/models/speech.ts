import type { Readable } from "node:stream";
import type { IAgentRuntime } from "@elizaos/core";
import { isCloudConnected, logger, toRuntimeSettings } from "@elizaos/core";
import type { OpenAITextToSpeechParams } from "../types";
import { getSetting, isBrowser } from "../utils/config";
import { webStreamToNodeStream } from "../utils/helpers";
import { createElizaCloudClient } from "../utils/sdk-client";

/**
 * Narrow client interface the speech handler actually exercises. Lets tests
 * substitute a fake without rebuilding the full SDK surface.
 */
export interface CloudTtsClient {
  routes: {
    postApiV1VoiceTts<T = unknown>(options: {
      headers?: Record<string, unknown>;
      json: { text: string; voiceId?: string; modelId?: string };
    }): Promise<T>;
  };
}

type CloudTtsClientFactory = (runtime: IAgentRuntime) => CloudTtsClient;

let cloudTtsClientFactory: CloudTtsClientFactory = (runtime) =>
  createElizaCloudClient(runtime) as unknown as CloudTtsClient;

/**
 * Test seam: substitute the SDK client factory used by `handleTextToSpeech`.
 * Pass `null` to reset to the real `createElizaCloudClient`. Production code
 * should never call this.
 */
export function setCloudTtsClientFactoryForTesting(
  factory: CloudTtsClientFactory | null,
): void {
  if (factory === null) {
    cloudTtsClientFactory = (runtime) =>
      createElizaCloudClient(runtime) as unknown as CloudTtsClient;
  } else {
    cloudTtsClientFactory = factory;
  }
}

/**
 * Extended TTS params accepted by the cloud handler.
 *
 * The runtime canonical type (`TextToSpeechParams`) only carries `text`, but
 * the cloud TTS upstream maps to ElevenLabs and therefore accepts arbitrary
 * ElevenLabs `voiceId` + `modelId`. We accept those via either OpenAI-style
 * (`voice`, `model`) or ElevenLabs-style (`voiceId`, `modelId`) fields and
 * normalize them to the upstream shape.
 */
export interface CloudTextToSpeechParams extends OpenAITextToSpeechParams {
  voiceId?: string;
  modelId?: string;
}

/**
 * Marker error used so the runtime can fall through to the next TTS handler
 * (e.g. local omnivoice) when Eliza Cloud is not connected.
 */
export class CloudTtsUnavailableError extends Error {
  constructor(message = "Eliza Cloud is not connected") {
    super(message);
    this.name = "CloudTtsUnavailableError";
  }
}

function normalizeTextInput(
  input: string | CloudTextToSpeechParams | OpenAITextToSpeechParams,
): CloudTextToSpeechParams {
  if (typeof input === "string") return { text: input };
  return input as CloudTextToSpeechParams;
}

/**
 * Pull an ElevenLabs `modelId` out of (in order):
 *   1. options.modelId — explicit ElevenLabs model id
 *   2. options.model with `elevenlabs/` prefix or `eleven_*` shape
 *
 * Returns `undefined` when nothing usable was provided so the upstream
 * can apply its own default (currently `eleven_flash_v2_5`).
 */
function resolveModelId(
  options: CloudTextToSpeechParams,
): string | undefined {
  if (options.modelId && options.modelId.trim()) {
    return options.modelId.trim();
  }
  const model = options.model?.trim();
  if (!model) return undefined;
  if (model.startsWith("elevenlabs/")) {
    return model.split("/").slice(1).join("/");
  }
  if (model.startsWith("eleven_")) {
    return model;
  }
  return undefined;
}

/**
 * Pull an ElevenLabs `voiceId` out of (in order):
 *   1. options.voiceId — explicit ElevenLabs voice id (preferred)
 *   2. options.voice — OpenAI-style voice name (rejected unless it looks
 *      like an ElevenLabs id, i.e. neither an OpenAI alias nor "nova")
 *
 * Returns `undefined` when nothing usable was provided so the upstream
 * can apply its own default voice.
 */
function resolveVoiceId(
  options: CloudTextToSpeechParams,
): string | undefined {
  if (options.voiceId && options.voiceId.trim()) {
    return options.voiceId.trim();
  }
  const voice = options.voice?.trim();
  if (!voice) return undefined;
  // "nova" is the OpenAI default — treat as unset so the upstream falls back
  // to the cloud default voice instead of being forwarded as an opaque alias.
  if (voice === "nova") return undefined;
  return voice;
}

async function fetchTextToSpeech(
  runtime: IAgentRuntime,
  options: CloudTextToSpeechParams,
): Promise<ReadableStream<Uint8Array> | Readable> {
  const format = options.format || "mp3";
  const modelId = resolveModelId(options);
  const voiceId = resolveVoiceId(options);

  try {
    const res = (await cloudTtsClientFactory(runtime).routes.postApiV1VoiceTts({
      headers: {
        ...(format === "mp3" ? { Accept: "audio/mpeg" } : {}),
      },
      json: {
        text: options.text,
        ...(voiceId ? { voiceId } : {}),
        ...(modelId ? { modelId } : {}),
      },
    })) as Response;

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`ElizaOS Cloud TTS error ${res.status}: ${err}`);
    }

    if (!res.body) {
      throw new Error("ElizaOS Cloud TTS response body is null");
    }

    if (!isBrowser()) {
      return await webStreamToNodeStream(res.body);
    }

    return res.body;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch speech from ElizaOS Cloud TTS: ${message}`);
  }
}

function toUint8Array(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  throw new TypeError(`Unexpected TTS chunk type: ${typeof chunk}`);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function webStreamToUint8Array(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(toUint8Array(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  return concatChunks(chunks);
}

async function nodeStreamToUint8Array(stream: Readable): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(toUint8Array(chunk));
  }
  return concatChunks(chunks);
}

function isReadableStream(
  stream: ReadableStream<Uint8Array> | Readable,
): stream is ReadableStream<Uint8Array> {
  return typeof (stream as { getReader?: unknown }).getReader === "function";
}

async function ttsStreamToBytes(
  stream: ReadableStream<Uint8Array> | Readable,
): Promise<Uint8Array> {
  if (isReadableStream(stream)) {
    return webStreamToUint8Array(stream);
  }
  return nodeStreamToUint8Array(stream);
}

/**
 * TEXT_TO_SPEECH handler for plugin-elizacloud.
 *
 * Behavior:
 *   - When Eliza Cloud is **not** connected, throws `CloudTtsUnavailableError`
 *     so the runtime's model-handler fallback chain can pick the next
 *     provider (e.g. local omnivoice, ElevenLabs direct, etc.).
 *   - When connected, forwards `text`, `voiceId`, and `modelId` to the
 *     upstream cloud TTS proxy and returns the audio stream.
 *
 * Accepts both OpenAI-style (`voice` / `model`) and ElevenLabs-style
 * (`voiceId` / `modelId`) input fields. ElevenLabs-style wins when both are
 * present.
 */
export async function handleTextToSpeech(
  runtime: IAgentRuntime,
  input: string | CloudTextToSpeechParams | OpenAITextToSpeechParams,
): Promise<Uint8Array> {
  if (!isCloudConnected(toRuntimeSettings(runtime))) {
    throw new CloudTtsUnavailableError(
      "Eliza Cloud is not connected — falling through to next TTS handler",
    );
  }

  const options = normalizeTextInput(input);

  const resolvedModel =
    options.modelId ||
    options.model ||
    (getSetting(runtime, "ELIZAOS_CLOUD_TTS_MODEL", "eleven_flash_v2_5") as string);
  logger.log(`[ELIZAOS_CLOUD] Using TEXT_TO_SPEECH model: ${resolvedModel}`);
  try {
    const speechStream = await fetchTextToSpeech(runtime, options);
    return ttsStreamToBytes(speechStream);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error in TEXT_TO_SPEECH: ${message}`);
    throw error;
  }
}

export { fetchTextToSpeech };
