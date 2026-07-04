/**
 * The `TRANSCRIPTION` model handler. Normalizes the several accepted input
 * shapes — URL string, `Buffer`, `Blob`/`File`, core `{ audioUrl }`, and the
 * local `{ audio, language?, model?, ... }` object — into base64 plus a detected
 * container format, then POSTs directly to OpenRouter's `/audio/transcriptions`
 * endpoint (not through the AI SDK). Format is sniffed from mime type, URL
 * extension, then magic bytes (`detectBufferFormat`). Emits a `MODEL_USED` event
 * from the response usage. URL inputs are constrained to http/https.
 */
import type { TranscriptionParams as CoreTranscriptionParams, IAgentRuntime } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";

import { getApiKey, getBaseURL, getTranscriptionModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

type AudioInput = Blob | File | Buffer;

interface OpenRouterTranscriptionParams {
  audio: AudioInput;
  format?: string;
  language?: string;
  mimeType?: string;
  model?: string;
  temperature?: number;
}

type TranscriptionInput =
  | AudioInput
  | CoreTranscriptionParams
  | OpenRouterTranscriptionParams
  | string;

interface OpenRouterTranscriptionResponse {
  text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

function isBlobOrFile(value: unknown): value is Blob | File {
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  return typeof File !== "undefined" && value instanceof File;
}

function isBuffer(value: unknown): value is Buffer {
  return typeof Buffer !== "undefined" && Buffer.isBuffer(value);
}

function isCoreTranscriptionParams(value: unknown): value is CoreTranscriptionParams {
  return (
    typeof value === "object" &&
    value !== null &&
    "audioUrl" in value &&
    typeof (value as CoreTranscriptionParams).audioUrl === "string"
  );
}

function isOpenRouterTranscriptionParams(value: unknown): value is OpenRouterTranscriptionParams {
  return (
    typeof value === "object" &&
    value !== null &&
    "audio" in value &&
    (isBlobOrFile((value as OpenRouterTranscriptionParams).audio) ||
      isBuffer((value as OpenRouterTranscriptionParams).audio))
  );
}

function audioFormatFromMimeType(mimeType: string | undefined): string | null {
  if (!mimeType?.startsWith("audio/")) return null;
  const subtype = mimeType.slice("audio/".length).split(";")[0]?.trim();
  if (!subtype) return null;
  if (subtype === "mpeg") return "mp3";
  if (subtype === "x-wav") return "wav";
  return subtype;
}

function audioFormatFromUrl(url: string): string | null {
  const pathname = new URL(url).pathname;
  const match = pathname.match(/\.([a-z0-9]+)$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function detectBufferFormat(buffer: Buffer): string {
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF") {
    return "wav";
  }
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "OggS") {
    return "ogg";
  }
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "fLaC") {
    return "flac";
  }
  if (buffer.length >= 3 && buffer.toString("ascii", 0, 3) === "ID3") {
    return "mp3";
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && ((buffer[1] ?? 0) & 0xe0) === 0xe0) {
    return "mp3";
  }
  return "webm";
}

function validateAudioUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("TRANSCRIPTION audioUrl must use http or https");
  }
  return parsed.toString();
}

async function fetchAudioFromUrl(url: string): Promise<{
  base64: string;
  format: string;
}> {
  const audioUrl = validateAudioUrl(url);
  // @trajectory-allow Fetches caller-provided audio bytes; no model inference happens here.
  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch audio from URL: ${audioUrl}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    base64: bytes.toString("base64"),
    format:
      audioFormatFromMimeType(response.headers.get("content-type") ?? undefined) ??
      audioFormatFromUrl(audioUrl) ??
      detectBufferFormat(bytes),
  };
}

async function encodeAudio(input: AudioInput): Promise<{
  base64: string;
  format: string;
}> {
  if (isBuffer(input)) {
    return {
      base64: input.toString("base64"),
      format: detectBufferFormat(input),
    };
  }

  const bytes = Buffer.from(await input.arrayBuffer());
  return {
    base64: bytes.toString("base64"),
    format:
      audioFormatFromMimeType(input.type) ??
      (typeof File !== "undefined" && input instanceof File
        ? audioFormatFromUrl(`https://local/${input.name}`)
        : null) ??
      detectBufferFormat(bytes),
  };
}

async function normalizeTranscriptionInput(input: TranscriptionInput): Promise<{
  audio: { data: string; format: string };
  language?: string;
  model?: string;
  temperature?: number;
}> {
  if (typeof input === "string") {
    const audio = await fetchAudioFromUrl(input);
    return { audio: { data: audio.base64, format: audio.format } };
  }
  if (isBlobOrFile(input) || isBuffer(input)) {
    const audio = await encodeAudio(input);
    return { audio: { data: audio.base64, format: audio.format } };
  }
  if (isCoreTranscriptionParams(input)) {
    const audio = await fetchAudioFromUrl(input.audioUrl);
    return { audio: { data: audio.base64, format: audio.format } };
  }
  if (isOpenRouterTranscriptionParams(input)) {
    const audio = await encodeAudio(input.audio);
    return {
      audio: {
        data: audio.base64,
        format: input.format ?? audioFormatFromMimeType(input.mimeType) ?? audio.format,
      },
      ...(input.language ? { language: input.language } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    };
  }

  throw new Error("TRANSCRIPTION expects Buffer, Blob, File, URL string, or TranscriptionParams");
}

export async function handleTranscription(
  runtime: IAgentRuntime,
  input: TranscriptionInput
): Promise<string> {
  const apiKey = getApiKey(runtime);
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const normalized = await normalizeTranscriptionInput(input);
  const modelName = normalized.model ?? getTranscriptionModel(runtime);
  const baseURL = getBaseURL(runtime);

  logger.debug(`[OpenRouter] Using TRANSCRIPTION model: ${modelName}`);

  // @trajectory-allow Audio bytes are caller-provided transcription input, not generated text.
  const response = await fetch(`${baseURL}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelName,
      input_audio: normalized.audio,
      ...(normalized.language ? { language: normalized.language } : {}),
      ...(normalized.temperature !== undefined ? { temperature: normalized.temperature } : {}),
    }),
  });

  if (!response.ok) {
    // error-policy:J6 best-effort diagnostics on an already-failed response —
    // the typed failure below throws regardless of whether the body was readable.
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `OpenRouter transcription failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const result = (await response.json()) as OpenRouterTranscriptionResponse;
  if (typeof result.text !== "string") {
    throw new Error("OpenRouter transcription response did not include text");
  }

  if (result.usage) {
    emitModelUsageEvent(
      runtime,
      ModelType.TRANSCRIPTION,
      "audio transcription",
      {
        inputTokens: result.usage.input_tokens ?? 0,
        outputTokens: result.usage.output_tokens ?? 0,
        totalTokens: result.usage.total_tokens ?? 0,
      },
      modelName
    );
  }

  return result.text;
}
