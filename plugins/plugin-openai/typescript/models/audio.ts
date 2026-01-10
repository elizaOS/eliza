/**
 * Audio model handlers
 *
 * Provides transcription and text-to-speech functionality.
 */

import type {
  IAgentRuntime,
  TranscriptionParams as CoreTranscriptionParams,
  TextToSpeechParams as CoreTextToSpeechParams,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  OpenAITranscriptionResponse,
  TextToSpeechParams as LocalTextToSpeechParams,
  TranscriptionParams as LocalTranscriptionParams,
  TTSOutputFormat,
  TTSVoice,
} from "../types";
import { detectAudioMimeType, getFilenameForMimeType } from "../utils/audio";
import {
  getAuthHeader,
  getBaseURL,
  getTranscriptionModel,
  getTTSInstructions,
  getTTSModel,
  getTTSVoice,
} from "../utils/config";

// ============================================================================
// Types
// ============================================================================

/**
 * Raw audio input types
 */
type AudioInput = Blob | File | Buffer;

/**
 * All accepted transcription input types
 * - Raw audio: Blob, File, Buffer
 * - Local params object with audio data
 * - Core params object with audioUrl string
 * - Plain string (treated as URL)
 */
type TranscriptionInput =
  | AudioInput
  | LocalTranscriptionParams
  | CoreTranscriptionParams
  | string;

/**
 * All accepted TTS input types
 * - Plain string (the text to speak)
 * - Local params object with strict voice type
 * - Core params object with string voice
 */
type TTSInput = string | LocalTextToSpeechParams | CoreTextToSpeechParams;

// ============================================================================
// Validation
// ============================================================================

/**
 * Type guard for Blob/File
 */
function isBlobOrFile(value: unknown): value is Blob | File {
  return value instanceof Blob || value instanceof File;
}

/**
 * Type guard for Buffer
 */
function isBuffer(value: unknown): value is Buffer {
  return Buffer.isBuffer(value);
}

/**
 * Type guard for local TranscriptionParams object (has audio property)
 */
function isLocalTranscriptionParams(
  value: unknown
): value is LocalTranscriptionParams {
  return (
    typeof value === "object" &&
    value !== null &&
    "audio" in value &&
    (isBlobOrFile((value as LocalTranscriptionParams).audio) ||
      isBuffer((value as LocalTranscriptionParams).audio))
  );
}

/**
 * Type guard for core TranscriptionParams object (has audioUrl property)
 */
function isCoreTranscriptionParams(
  value: unknown
): value is CoreTranscriptionParams {
  return (
    typeof value === "object" &&
    value !== null &&
    "audioUrl" in value &&
    typeof (value as CoreTranscriptionParams).audioUrl === "string"
  );
}

// ============================================================================
// Audio Fetching
// ============================================================================

/**
 * Fetches audio from a URL and returns a Blob
 */
async function fetchAudioFromUrl(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch audio from URL: ${response.status}`);
  }
  return response.blob();
}

// ============================================================================
// Transcription
// ============================================================================

/**
 * Handles audio transcription using OpenAI's transcription API.
 *
 * Supports multiple input types:
 * - Raw audio: Blob, File, Buffer
 * - Local params object with `audio` property
 * - Core params object with `audioUrl` string property
 * - Plain URL string
 *
 * @param runtime - The agent runtime
 * @param input - Audio data, URL, or transcription params
 * @returns The transcribed text
 * @throws Error if transcription fails
 */
export async function handleTranscription(
  runtime: IAgentRuntime,
  input: TranscriptionInput
): Promise<string> {
  let modelName = getTranscriptionModel(runtime);
  let blob: Blob;
  let extraParams: Partial<LocalTranscriptionParams> = {};

  // Handle different input types
  if (typeof input === "string") {
    // String input - treat as URL
    logger.debug(`[OpenAI] Fetching audio from URL: ${input}`);
    blob = await fetchAudioFromUrl(input);
  } else if (isBlobOrFile(input)) {
    blob = input;
  } else if (isBuffer(input)) {
    const mimeType = detectAudioMimeType(input);
    logger.debug(`[OpenAI] Auto-detected audio MIME type: ${mimeType}`);
    blob = new Blob([new Uint8Array(input)], { type: mimeType });
  } else if (isLocalTranscriptionParams(input)) {
    // Local params with audio data
    extraParams = input;

    // Override model if specified in params
    if (input.model) {
      modelName = input.model;
    }

    // Convert audio to blob
    if (isBuffer(input.audio)) {
      const mimeType = input.mimeType ?? detectAudioMimeType(input.audio);
      logger.debug(`[OpenAI] Using MIME type: ${mimeType}`);
      blob = new Blob([new Uint8Array(input.audio)], { type: mimeType });
    } else {
      blob = input.audio;
    }
  } else if (isCoreTranscriptionParams(input)) {
    // Core params with audioUrl
    logger.debug(`[OpenAI] Fetching audio from URL: ${input.audioUrl}`);
    blob = await fetchAudioFromUrl(input.audioUrl);
    extraParams = { prompt: input.prompt };
  } else {
    throw new Error(
      "TRANSCRIPTION expects Blob, File, Buffer, URL string, or TranscriptionParams object"
    );
  }

  logger.debug(`[OpenAI] Using TRANSCRIPTION model: ${modelName}`);

  // Determine filename from MIME type
  const mimeType = (blob as File).type || "audio/webm";
  const filename =
    (blob as File).name ||
    getFilenameForMimeType(
      mimeType.startsWith("audio/")
        ? (mimeType as ReturnType<typeof detectAudioMimeType>)
        : "audio/webm"
    );

  // Build form data
  const formData = new FormData();
  formData.append("file", blob, filename);
  formData.append("model", modelName);

  // Add optional parameters
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
  const response = await fetch(`${baseURL}/audio/transcriptions`, {
    method: "POST",
    headers: getAuthHeader(runtime),
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `OpenAI transcription failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const data = (await response.json()) as OpenAITranscriptionResponse;
  return data.text;
}

// ============================================================================
// Text-to-Speech
// ============================================================================

/**
 * Handles text-to-speech generation using OpenAI's TTS API.
 *
 * Supports multiple input types:
 * - Plain string (the text to speak)
 * - Local params object with strict voice type
 * - Core params object with string voice
 *
 * @param runtime - The agent runtime
 * @param input - Text string or TTS params
 * @returns Audio data as ArrayBuffer
 * @throws Error if TTS generation fails
 */
export async function handleTextToSpeech(
  runtime: IAgentRuntime,
  input: TTSInput
): Promise<ArrayBuffer> {
  // Normalize input
  let text: string;
  let voice: string | undefined;
  let format: TTSOutputFormat = "mp3";
  let model: string;
  let instructions: string | undefined;

  if (typeof input === "string") {
    text = input;
    voice = undefined;
  } else {
    text = input.text;
    voice = input.voice;

    // Handle local params specific properties
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

  // Get configuration with defaults
  model = model! ?? getTTSModel(runtime);
  voice = voice ?? getTTSVoice(runtime);
  instructions = instructions ?? getTTSInstructions(runtime);

  logger.debug(`[OpenAI] Using TEXT_TO_SPEECH model: ${model}`);

  // Validate text
  if (!text || text.trim().length === 0) {
    throw new Error("TEXT_TO_SPEECH requires non-empty text");
  }

  if (text.length > 4096) {
    throw new Error("TEXT_TO_SPEECH text exceeds 4096 character limit");
  }

  // Validate voice - cast to TTSVoice for type safety
  const validVoices: TTSVoice[] = [
    "alloy",
    "echo",
    "fable",
    "onyx",
    "nova",
    "shimmer",
  ];
  if (voice && !validVoices.includes(voice as TTSVoice)) {
    throw new Error(
      `Invalid voice: ${voice}. Must be one of: ${validVoices.join(", ")}`
    );
  }

  const baseURL = getBaseURL(runtime);

  // Build request body
  const requestBody: Record<string, string> = {
    model,
    voice: voice as TTSVoice,
    input: text,
    response_format: format,
  };

  if (instructions && instructions.length > 0) {
    requestBody.instructions = instructions;
  }

  const response = await fetch(`${baseURL}/audio/speech`, {
    method: "POST",
    headers: {
      ...getAuthHeader(runtime),
      "Content-Type": "application/json",
      ...(format === "mp3" ? { Accept: "audio/mpeg" } : {}),
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `OpenAI TTS failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  return response.arrayBuffer();
}
