import type {
  TextToSpeechParams as CoreTextToSpeechParams,
  TranscriptionParams as CoreTranscriptionParams,
  IAgentRuntime,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  TextToSpeechParams as LocalTextToSpeechParams,
  TranscriptionParams as LocalTranscriptionParams,
  OpenAITranscriptionResponse,
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

type AudioInput = Blob | File | Buffer;
type TranscriptionInput = AudioInput | LocalTranscriptionParams | CoreTranscriptionParams | string;
type TTSInput = string | LocalTextToSpeechParams | CoreTextToSpeechParams;

function isBlobOrFile(value: unknown): value is Blob | File {
  return value instanceof Blob || value instanceof File;
}

function isBuffer(value: unknown): value is Buffer {
  return Buffer.isBuffer(value);
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

async function fetchAudioFromUrl(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch audio from URL: ${response.status}`);
  }
  return response.blob();
}
export async function handleTranscription(
  runtime: IAgentRuntime,
  input: TranscriptionInput
): Promise<string> {
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
  const filename =
    (blob as File).name ||
    getFilenameForMimeType(
      mimeType.startsWith("audio/")
        ? (mimeType as ReturnType<typeof detectAudioMimeType>)
        : "audio/webm"
    );

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

export async function handleTextToSpeech(
  runtime: IAgentRuntime,
  input: TTSInput
): Promise<ArrayBuffer> {
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
    throw new Error(`OpenAI TTS failed: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return response.arrayBuffer();
}
