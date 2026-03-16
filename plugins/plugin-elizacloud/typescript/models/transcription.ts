import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { OpenAITranscriptionParams } from "../types";
import { getAuthHeader, getBaseURL, getSetting } from "../utils/config";
import { detectAudioMimeType } from "../utils/helpers";

export async function handleTranscription(
  runtime: IAgentRuntime,
  input: Blob | File | Buffer | OpenAITranscriptionParams,
): Promise<string> {
  let modelName = getSetting(
    runtime,
    "ELIZAOS_CLOUD_TRANSCRIPTION_MODEL",
    "gpt-5-mini-transcribe",
  );
  logger.log(`[ELIZAOS_CLOUD] Using TRANSCRIPTION model: ${modelName}`);

  const baseURL = getBaseURL(runtime);

  let blob: Blob;
  let extraParams: OpenAITranscriptionParams | null = null;

  if (input instanceof Blob || input instanceof File) {
    blob = input as Blob;
  } else if (Buffer.isBuffer(input)) {
    const detectedMimeType = detectAudioMimeType(input);
    logger.debug(`Auto-detected audio MIME type: ${detectedMimeType}`);
    blob = new Blob([input] as never, { type: detectedMimeType });
  } else if (
    typeof input === "object" &&
    input !== null &&
    "audio" in input &&
    input.audio != null
  ) {
    const params = input as OpenAITranscriptionParams;
    if (
      !(params.audio instanceof Blob) &&
      !(params.audio instanceof File) &&
      !Buffer.isBuffer(params.audio)
    ) {
      throw new Error(
        "TRANSCRIPTION param 'audio' must be a Blob/File/Buffer.",
      );
    }
    if (Buffer.isBuffer(params.audio)) {
      let mimeType = params.mimeType;
      if (!mimeType) {
        mimeType = detectAudioMimeType(params.audio);
        logger.debug(`Auto-detected audio MIME type: ${mimeType}`);
      } else {
        logger.debug(`Using provided MIME type: ${mimeType}`);
      }
      blob = new Blob([params.audio] as never, { type: mimeType });
    } else {
      blob = params.audio as Blob;
    }
    extraParams = params;
    if (typeof params.model === "string" && params.model) {
      modelName = params.model;
    }
  } else {
    throw new Error(
      "TRANSCRIPTION expects a Blob/File/Buffer or an object { audio: Blob/File/Buffer, mimeType?, language?, response_format?, timestampGranularities?, prompt?, temperature?, model? }",
    );
  }

  const mime = (blob as File).type || "audio/webm";
  const filename =
    (blob as File).name ||
    (mime.includes("mp3") || mime.includes("mpeg")
      ? "recording.mp3"
      : mime.includes("ogg")
        ? "recording.ogg"
        : mime.includes("wav")
          ? "recording.wav"
          : mime.includes("webm")
            ? "recording.webm"
            : "recording.bin");

  const formData = new FormData();
  formData.append("file", blob, filename);
  formData.append("model", String(modelName));
  if (extraParams) {
    if (typeof extraParams.language === "string") {
      formData.append("language", String(extraParams.language));
    }
    if (typeof extraParams.response_format === "string") {
      formData.append("response_format", String(extraParams.response_format));
    }
    if (typeof extraParams.prompt === "string") {
      formData.append("prompt", String(extraParams.prompt));
    }
    if (typeof extraParams.temperature === "number") {
      formData.append("temperature", String(extraParams.temperature));
    }
    if (Array.isArray(extraParams.timestampGranularities)) {
      for (const g of extraParams.timestampGranularities) {
        formData.append("timestamp_granularities[]", String(g));
      }
    }
  }

  try {
    const response = await fetch(`${baseURL}/audio/transcriptions`, {
      method: "POST",
      headers: {
        ...getAuthHeader(runtime),
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(
        `Failed to transcribe audio: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { text: string };
    return data.text || "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`TRANSCRIPTION error: ${message}`);
    throw error;
  }
}
