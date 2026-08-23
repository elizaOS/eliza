/**
 * OpenAI-compatible speech endpoints on an Ollama / zerollama host.
 *
 * Wired only when `OLLAMA_TTS_MODEL` / `OLLAMA_TRANSCRIPTION_MODEL` are set so
 * text-only Ollama installs keep working without claiming voice capabilities.
 * Calls `POST {apiBase}/v1/audio/speech` and `…/transcriptions` (Piper / Whisper
 * or multimodal backends on zerollama).
 */
import type {
  TextToSpeechParams as CoreTextToSpeechParams,
  TranscriptionParams as CoreTranscriptionParams,
  IAgentRuntime,
  RecordLlmCallDetails,
} from "@elizaos/core";
import { logger, recordLlmCall, toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import {
  getApiBase,
  getTranscriptionModel,
  getTtsModel,
  getTtsSpeed,
  getTtsVoice,
  isOllamaTranscriptionEnabled,
  isOllamaTtsEnabled,
} from "../utils/config";

type AudioInput = Blob | File | Buffer | Uint8Array | ArrayBuffer;
type TranscriptionInput =
  | AudioInput
  | CoreTranscriptionParams
  | {
      audio: AudioInput;
      mimeType?: string;
      language?: string;
      prompt?: string;
      model?: string;
      signal?: AbortSignal;
    }
  | string;
type TtsInput =
  | string
  | CoreTextToSpeechParams
  | {
      text: string;
      voice?: string;
      model?: string;
      speed?: number;
      format?: string;
      signal?: AbortSignal;
    };

function isBuffer(value: unknown): value is Buffer {
  return typeof Buffer !== "undefined" && Buffer.isBuffer(value);
}

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer;
}

function isBlobOrFile(value: unknown): value is Blob | File {
  return typeof Blob !== "undefined" && (value instanceof Blob || value instanceof File);
}

function sniffAudioMime(bytes: Uint8Array): string {
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return "audio/wav";
  }
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return "audio/mpeg";
  }
  const secondByte = bytes[1];
  if (bytes[0] === 0xff && secondByte !== undefined && (secondByte & 0xe0) === 0xe0) {
    return "audio/mpeg";
  }
  return "audio/wav";
}

function filenameForMime(mime: string): string {
  if (mime.includes("mpeg") || mime.includes("mp3")) return "audio.mp3";
  if (mime.includes("ogg")) return "audio.ogg";
  if (mime.includes("webm")) return "audio.webm";
  if (mime.includes("flac")) return "audio.flac";
  return "audio.wav";
}

async function toBlob(audio: AudioInput, mimeHint?: string): Promise<Blob> {
  if (isBlobOrFile(audio)) return audio;
  let bytes: Uint8Array;
  if (isBuffer(audio) || isUint8Array(audio)) {
    bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
  } else if (isArrayBuffer(audio)) {
    bytes = new Uint8Array(audio);
  } else {
    throw new Error("Unsupported audio input for Ollama transcription");
  }
  const mime = mimeHint ?? sniffAudioMime(bytes);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: mime });
}

async function fetchAudioFromUrl(url: string, signal?: AbortSignal): Promise<Blob> {
  // @trajectory-allow Fetches caller-provided audio bytes; no model inference happens here.
  const { fetchWithSsrfGuard, readResponseWithLimit } = await import("@elizaos/core/node");
  const { response, release } = await fetchWithSsrfGuard({
    url,
    timeoutMs: 30_000,
    signal,
  });
  try {
    if (!response.ok) {
      throw new Error(
        `Failed to fetch Ollama transcription audio: ${response.status} ${response.statusText}`
      );
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 25 * 1024 * 1024) {
      throw new Error("Ollama transcription audio exceeds the 25 MiB limit");
    }
    // Stream under the hard cap: a missing or lying Content-Length must never
    // let the body buffer unbounded into memory before the size check runs.
    const bytes = await readResponseWithLimit(response, 25 * 1024 * 1024);
    return new Blob([new Uint8Array(bytes)], {
      type: response.headers.get("content-type") ?? "audio/wav",
    });
  } finally {
    await release();
  }
}

async function readHttpErrorDetail(response: Response): Promise<string> {
  try {
    const detail = (await response.text()).trim();
    return detail.length > 0
      ? truncateWellFormed(toWellFormedUnicode(detail), 500)
      : "empty response body";
  } catch (error) {
    // error-policy:J4 the status remains authoritative and the unavailable
    // diagnostic body is represented explicitly.
    return `response body unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function resolveFetch(runtime: IAgentRuntime): typeof fetch {
  return (runtime as { fetch?: typeof fetch }).fetch ?? fetch;
}

/** Piper-style voice ids (`en_US-female-medium`) — not Ollama model tags. */
function isPiperVoiceTag(value: string): boolean {
  return /^[a-z]{2}_[A-Z]{2}-[a-z0-9_-]+$/i.test(value.trim());
}

export async function handleTranscription(
  runtime: IAgentRuntime,
  input: TranscriptionInput
): Promise<string> {
  if (!isOllamaTranscriptionEnabled(runtime)) {
    throw new Error(
      "Ollama TRANSCRIPTION is disabled — set OLLAMA_TRANSCRIPTION_MODEL (or OLLAMA_ASR_MODEL) to a speech-capable tag"
    );
  }

  let model = getTranscriptionModel(runtime);
  let language: string | undefined;
  let prompt: string | undefined;
  let signal: AbortSignal | undefined;
  let blob: Blob;

  if (typeof input === "string") {
    blob = await fetchAudioFromUrl(input);
  } else if (
    isBlobOrFile(input) ||
    isBuffer(input) ||
    isUint8Array(input) ||
    isArrayBuffer(input)
  ) {
    blob = await toBlob(input);
  } else if (
    input &&
    typeof input === "object" &&
    "audioUrl" in input &&
    typeof input.audioUrl === "string"
  ) {
    signal = input.signal;
    blob = await fetchAudioFromUrl(input.audioUrl, signal);
    prompt = typeof input.prompt === "string" ? input.prompt : undefined;
  } else if (input && typeof input === "object" && "audio" in input) {
    const params = input as {
      audio: AudioInput;
      mimeType?: string;
      language?: string;
      prompt?: string;
      model?: string;
      signal?: AbortSignal;
    };
    if (typeof params.model === "string" && params.model.trim()) {
      model = params.model.trim();
    }
    language = typeof params.language === "string" ? params.language : undefined;
    prompt = typeof params.prompt === "string" ? params.prompt : undefined;
    signal = params.signal;
    blob = await toBlob(params.audio, params.mimeType);
  } else {
    throw new Error(
      "TRANSCRIPTION expects Blob, File, Buffer, URL string, or { audio } / { audioUrl }"
    );
  }

  const mimeType = (blob as File).type || "audio/wav";
  const filename = (blob as File).name || filenameForMime(mimeType);
  const formData = new FormData();
  formData.append("file", blob, filename);
  formData.append("model", model);
  if (language) formData.append("language", language);
  if (prompt) formData.append("prompt", prompt);
  formData.append("response_format", "json");

  const apiBase = getApiBase(runtime);
  const url = `${apiBase}/v1/audio/transcriptions`;
  logger.debug(`[ollama] TRANSCRIPTION model=${model} url=${url}`);

  const details: RecordLlmCallDetails = {
    model,
    systemPrompt: prompt ?? "",
    userPrompt: `audio transcription request: filename=${filename} mimeType=${mimeType}`,
    temperature: 0,
    maxTokens: 0,
    purpose: "external_llm",
    actionType: "ollama.audio.transcriptions.create",
  };
  return recordLlmCall(runtime, details, async () => {
    const response = await resolveFetch(runtime)(url, {
      method: "POST",
      body: formData,
      signal,
    });
    if (!response.ok) {
      const errorText = await readHttpErrorDetail(response);
      throw new Error(
        `Ollama transcription failed: ${response.status} ${response.statusText} - ${errorText}`
      );
    }
    const result = (await response.json()) as { text?: string };
    const text = typeof result.text === "string" ? result.text.trim() : "";
    if (!text) {
      throw new Error("Ollama transcription returned empty text");
    }
    details.response = text;
    return text;
  });
}

export async function handleTextToSpeech(
  runtime: IAgentRuntime,
  input: TtsInput
): Promise<ArrayBuffer> {
  if (!isOllamaTtsEnabled(runtime)) {
    throw new Error(
      "Ollama TEXT_TO_SPEECH is disabled — set OLLAMA_TTS_MODEL to a speech-capable tag (Piper)"
    );
  }

  let text: string;
  let voice = getTtsVoice(runtime);
  let model = getTtsModel(runtime);
  let speed = getTtsSpeed(runtime);
  let format = "wav";
  let signal: AbortSignal | undefined;

  if (typeof input === "string") {
    text = input;
  } else {
    text = input.text;
    signal = input.signal;
    if (typeof input.voice === "string" && input.voice.trim()) {
      voice = input.voice.trim();
    }
    if ("model" in input && typeof input.model === "string" && input.model.trim()) {
      const override = input.model.trim();
      // Character `settings.voice.model` historically held a Piper *voice* tag
      // (`en_US-female-medium`), not a speech-model id. Treating that as `model`
      // 404s on Ollama/zerollama — demote it to the OpenAI `voice` field.
      if (isPiperVoiceTag(override)) {
        voice = voice ?? override;
      } else {
        model = override;
      }
    }
    if ("speed" in input && typeof input.speed === "number" && Number.isFinite(input.speed)) {
      speed = input.speed;
    }
    if ("format" in input && typeof input.format === "string" && input.format.trim()) {
      format = input.format.trim();
    }
  }

  if (!text || text.trim().length === 0) {
    throw new Error("TEXT_TO_SPEECH requires non-empty text");
  }
  if (text.length > 4096) {
    throw new Error("TEXT_TO_SPEECH text exceeds 4096 character limit");
  }

  const apiBase = getApiBase(runtime);
  const url = `${apiBase}/v1/audio/speech`;
  const body: Record<string, unknown> = {
    model,
    input: text,
    response_format: format === "mp3" ? "mp3" : "wav",
  };
  if (voice) body.voice = voice;
  if (speed !== undefined) body.speed = speed;

  logger.debug(`[ollama] TEXT_TO_SPEECH model=${model} voice=${voice ?? "(default)"} url=${url}`);

  const details: RecordLlmCallDetails = {
    model,
    systemPrompt: "",
    userPrompt: text,
    temperature: 0,
    maxTokens: 0,
    purpose: "external_llm",
    actionType: "ollama.audio.speech.create",
  };
  return recordLlmCall(runtime, details, async () => {
    const response = await resolveFetch(runtime)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const errorText = await readHttpErrorDetail(response);
      throw new Error(
        `Ollama TTS failed: ${response.status} ${response.statusText} - ${errorText}`
      );
    }
    const audioBuffer = await response.arrayBuffer();
    if (audioBuffer.byteLength === 0) {
      throw new Error("Ollama TTS returned empty audio");
    }
    details.response = `[audio bytes=${audioBuffer.byteLength}]`;
    return audioBuffer;
  });
}
