/**
 * Audio model handlers: `handleTranscription` uploads audio to the transcription
 * endpoint (sniffing the container via `detectAudioMimeType` to pick an upload
 * filename), and `handleTextToSpeech` synthesizes speech via the TTS endpoint.
 * Both accept the core param shapes as well as raw Blob/File/Buffer input.
 *
 * Caller-supplied audio URLs load only through the platform-installed guarded
 * fetcher (`models/transcription-url.ts`) so agents and tools cannot aim
 * transcription at loopback, link-local, or private hosts, and so this shared
 * module never names a Node-only core subpath a browser bundle would follow.
 * Provider endpoint calls (OpenAI-compatible base URL) stay on the configured
 * API path and are not remote-media fetches.
 */
import type {
  TextToSpeechParams as CoreTextToSpeechParams,
  TranscriptionParams as CoreTranscriptionParams,
  IAgentRuntime,
  RecordLlmCallDetails,
} from "@elizaos/core";
import { logger, recordLlmCall } from "@elizaos/core";
import type {
  TextToSpeechParams as LocalTextToSpeechParams,
  TranscriptionParams as LocalTranscriptionParams,
  OpenAITranscriptionResponse,
  TTSOutputFormat,
  TTSVoice,
} from "../types";
import type { AudioMimeType } from "../utils/audio";
import {
  detectAudioMimeType,
  getFilenameForMimeType,
  normalizeAudioMimeType,
} from "../utils/audio";
import {
  getAuthHeader,
  getBaseURL,
  getTranscriptionModel,
  getTTSInstructions,
  getTTSModel,
  getTTSVoice,
} from "../utils/config";
import { fetchAudioFromUrl } from "./transcription-url";

type AudioInput = Blob | File | Buffer;
type TranscriptionInput = AudioInput | LocalTranscriptionParams | CoreTranscriptionParams | string;
type TTSInput = string | LocalTextToSpeechParams | CoreTextToSpeechParams;

function isBlobOrFile(value: unknown): value is Blob | File {
  return value instanceof Blob || value instanceof File;
}

function isBuffer(value: unknown): value is Buffer {
  // A real browser has no Buffer global; referencing it bare throws.
  return typeof Buffer !== "undefined" && Buffer.isBuffer(value);
}

function isLocalTranscriptionParams(value: unknown): value is LocalTranscriptionParams {
  return (
    typeof value === "object" &&
    value !== null &&
    "audio" in value &&
    (isBlobOrFile((value as LocalTranscriptionParams).audio) ||
      isBuffer((value as LocalTranscriptionParams).audio))
  );
}

function isCoreTranscriptionParams(value: unknown): value is CoreTranscriptionParams {
  return (
    typeof value === "object" &&
    value !== null &&
    "audioUrl" in value &&
    typeof (value as CoreTranscriptionParams).audioUrl === "string"
  );
}

/** Enough leading bytes for every `detectAudioMimeType` magic-byte probe. */
const AUDIO_SNIFF_BYTES = 64;

/**
 * Choose the canonical audio type used to label the multipart upload. The
 * container bytes are authoritative — a valid MP3 served with a non-canonical
 * `Content-Type: audio/mp3` still uploads as `recording.mp3` — and only when
 * sniffing is inconclusive do we fall back to normalizing the declared type.
 * This keeps the derived extension inside the recognized set OpenAI's
 * /audio/transcriptions accepts instead of emitting `recording.undefined`.
 */
async function resolveUploadMimeType(blob: Blob, declaredType: string): Promise<AudioMimeType> {
  const header = new Uint8Array(await blob.slice(0, AUDIO_SNIFF_BYTES).arrayBuffer());
  const sniffed = detectAudioMimeType(header);
  if (sniffed !== "application/octet-stream") {
    return sniffed;
  }
  return normalizeAudioMimeType(declaredType);
}

const AUDIO_TRANSCRIPTION_TIMEOUT_MS = 120_000;

const AUDIO_TTS_TIMEOUT_MS = 60_000;

function extractAbortSignal(input: unknown): AbortSignal | undefined {
  if (typeof input !== "object" || input === null || !("signal" in input)) {
    return undefined;
  }
  const signal = (input as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function requestSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}

export async function handleTranscription(
  runtime: IAgentRuntime,
  input: TranscriptionInput
): Promise<string> {
  const callerSignal = extractAbortSignal(input);
  let modelName = getTranscriptionModel(runtime);
  let blob: Blob;
  let extraParams: Partial<LocalTranscriptionParams> = {};

  if (typeof input === "string") {
    logger.debug(`[OpenAI] Fetching audio from URL: ${input}`);
    blob = await fetchAudioFromUrl(input);
  } else if (isBlobOrFile(input)) {
    blob = input;
  } else if (isBuffer(input)) {
    const mimeType = detectAudioMimeType(input);
    logger.debug(`[OpenAI] Auto-detected audio MIME type: ${mimeType}`);
    blob = new Blob([new Uint8Array(input)], { type: mimeType });
  } else if (isLocalTranscriptionParams(input)) {
    extraParams = input;
    if (input.model) {
      modelName = input.model;
    }
    if (isBuffer(input.audio)) {
      const mimeType = input.mimeType ?? detectAudioMimeType(input.audio);
      logger.debug(`[OpenAI] Using MIME type: ${mimeType}`);
      blob = new Blob([new Uint8Array(input.audio)], { type: mimeType });
    } else {
      blob = input.audio;
    }
  } else if (isCoreTranscriptionParams(input)) {
    logger.debug(`[OpenAI] Fetching audio from URL: ${input.audioUrl}`);
    blob = await fetchAudioFromUrl(input.audioUrl);
    extraParams = { prompt: input.prompt };
  } else {
    throw new Error(
      "TRANSCRIPTION expects Blob, File, Buffer, URL string, or TranscriptionParams object"
    );
  }

  logger.debug(`[OpenAI] Using TRANSCRIPTION model: ${modelName}`);

  const mimeType = (blob as File).type || "audio/webm";
  const providedName = (blob as File).name;
  const filename =
    providedName || getFilenameForMimeType(await resolveUploadMimeType(blob, mimeType));

  const formData = new FormData();
  formData.append("file", blob, filename);
  formData.append("model", modelName);

  if (extraParams.language) {
    formData.append("language", extraParams.language);
  }
  if (extraParams.responseFormat) {
    formData.append("response_format", extraParams.responseFormat);
  }
  if (extraParams.prompt) {
    formData.append("prompt", extraParams.prompt);
  }
  if (extraParams.temperature !== undefined) {
    formData.append("temperature", String(extraParams.temperature));
  }
  if (extraParams.timestampGranularities) {
    for (const granularity of extraParams.timestampGranularities) {
      formData.append("timestamp_granularities[]", granularity);
    }
  }

  const baseURL = getBaseURL(runtime);
  const details: RecordLlmCallDetails = {
    model: modelName,
    systemPrompt: extraParams.prompt ?? "",
    userPrompt: [
      `audio transcription request: filename=${filename}`,
      `mimeType=${mimeType}`,
      extraParams.language ? `language=${extraParams.language}` : "",
      extraParams.responseFormat ? `responseFormat=${extraParams.responseFormat}` : "",
    ]
      .filter(Boolean)
      .join(" "),
    temperature: extraParams.temperature ?? 0,
    maxTokens: 0,
    purpose: "external_llm",
    actionType: "openai.audio.transcriptions.create",
  };
  const data = await recordLlmCall(runtime, details, async () => {
    const response = await fetch(`${baseURL}/audio/transcriptions`, {
      method: "POST",
      headers: getAuthHeader(runtime),
      body: formData,
      signal: requestSignal(callerSignal, AUDIO_TRANSCRIPTION_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `OpenAI transcription failed: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const result = (await response.json()) as OpenAITranscriptionResponse;
    details.response = result.text;
    return result;
  });
  return data.text;
}

export async function handleTextToSpeech(
  runtime: IAgentRuntime,
  input: TTSInput
): Promise<ArrayBuffer> {
  const callerSignal = extractAbortSignal(input);
  let text: string;
  let voice: string | undefined;
  let format: TTSOutputFormat = "mp3";
  let model: string | undefined;
  let instructions: string | undefined;

  if (typeof input === "string") {
    text = input;
    voice = undefined;
  } else {
    text = input.text;
    voice = input.voice;
    if ("format" in input && input.format) {
      format = input.format;
    }
    if ("model" in input && input.model) {
      model = input.model;
    }
    if ("instructions" in input && input.instructions) {
      instructions = input.instructions;
    }
  }

  model = model ?? getTTSModel(runtime);
  voice = voice ?? getTTSVoice(runtime);
  instructions = instructions ?? getTTSInstructions(runtime);

  logger.debug(`[OpenAI] Using TEXT_TO_SPEECH model: ${model}`);

  if (!text || text.trim().length === 0) {
    throw new Error("TEXT_TO_SPEECH requires non-empty text");
  }

  if (text.length > 4096) {
    throw new Error("TEXT_TO_SPEECH text exceeds 4096 character limit");
  }

  const validVoices: TTSVoice[] = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
  if (voice && !validVoices.includes(voice as TTSVoice)) {
    throw new Error(`Invalid voice: ${voice}. Must be one of: ${validVoices.join(", ")}`);
  }

  const baseURL = getBaseURL(runtime);

  const requestBody: Record<string, string> = {
    model,
    voice: voice as TTSVoice,
    input: text,
    response_format: format,
  };

  if (instructions && instructions.length > 0) {
    requestBody.instructions = instructions;
  }

  const details: RecordLlmCallDetails = {
    model,
    systemPrompt: instructions,
    userPrompt: text,
    temperature: 0,
    maxTokens: 0,
    purpose: "external_llm",
    actionType: "openai.audio.speech.create",
  };
  return recordLlmCall(runtime, details, async () => {
    const response = await fetch(`${baseURL}/audio/speech`, {
      method: "POST",
      headers: {
        ...getAuthHeader(runtime),
        "Content-Type": "application/json",
        ...(format === "mp3" ? { Accept: "audio/mpeg" } : {}),
      },
      body: JSON.stringify(requestBody),
      signal: requestSignal(callerSignal, AUDIO_TTS_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `OpenAI TTS failed: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const audioBuffer = await response.arrayBuffer();
    details.response = `[audio bytes=${audioBuffer.byteLength} format=${format}]`;
    return audioBuffer;
  });
}
