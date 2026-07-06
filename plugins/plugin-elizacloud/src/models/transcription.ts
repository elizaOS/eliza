import type { IAgentRuntime, TranscriptionParams } from "@elizaos/core";
import { fetchWithSsrfGuard, logger } from "@elizaos/core";
import type { OpenAITranscriptionParams } from "../types";
import { isCloudSttAvailable, resolveCloudTimeoutMs } from "../utils/config";
import { detectAudioMimeType } from "../utils/helpers";
import { createElizaCloudClient } from "../utils/sdk-client";

/**
 * Thrown when Cloud STT cannot serve (no API key, or neither
 * `ELIZAOS_CLOUD_ENABLED` nor `ELIZAOS_CLOUD_USE_STT` is set). The
 * local-inference router catches any provider error and falls through to the
 * next eligible TRANSCRIPTION provider — the STT counterpart of
 * `CloudTtsUnavailableError` in `speech.ts`.
 */
export class CloudSttUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudSttUnavailableError";
  }
}

/** Every input shape core documents for `ModelType.TRANSCRIPTION` plus the plugin's own param object. */
export type CloudTranscriptionInput =
  | Blob
  | File
  | Buffer
  | string
  | TranscriptionParams
  | OpenAITranscriptionParams;

function isCoreTranscriptionParams(input: object): input is TranscriptionParams {
  return "audioUrl" in input && typeof (input as { audioUrl: unknown }).audioUrl === "string";
}

/**
 * Fetch caller-provided audio bytes from an http(s) URL through the SSRF
 * guard (the repo's convention for every server-side attachment fetch) so a
 * crafted `audioUrl` can't reach internal/metadata endpoints.
 */
async function fetchAudioFromUrl(url: string, signal?: AbortSignal): Promise<Blob> {
  const { response, release } = await fetchWithSsrfGuard({
    url,
    timeoutMs: 30_000,
    signal,
  });
  try {
    if (!response.ok) {
      throw new Error(
        `Failed to fetch TRANSCRIPTION audioUrl: ${response.status} ${response.statusText}`
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type") || detectAudioMimeType(bytes);
    return new Blob([bytes] as never, { type: mimeType });
  } finally {
    await release();
  }
}

export async function handleTranscription(
  runtime: IAgentRuntime,
  input: CloudTranscriptionInput
): Promise<string> {
  if (!isCloudSttAvailable(runtime)) {
    throw new CloudSttUnavailableError(
      "Eliza Cloud STT is not available — falling through to next TRANSCRIPTION handler"
    );
  }

  let blob: Blob;
  let extraParams: OpenAITranscriptionParams | null = null;

  if (input instanceof Blob || input instanceof File) {
    blob = input as Blob;
  } else if (Buffer.isBuffer(input)) {
    const detectedMimeType = detectAudioMimeType(input);
    logger.debug(`Auto-detected audio MIME type: ${detectedMimeType}`);
    blob = new Blob([input] as never, { type: detectedMimeType });
  } else if (typeof input === "string") {
    blob = await fetchAudioFromUrl(input);
  } else if (typeof input === "object" && input !== null && isCoreTranscriptionParams(input)) {
    blob = await fetchAudioFromUrl(input.audioUrl, input.signal);
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
      throw new Error("TRANSCRIPTION param 'audio' must be a Blob/File/Buffer.");
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
  } else {
    throw new Error(
      "TRANSCRIPTION expects a Blob/File/Buffer, an http(s) audio URL string, { audioUrl }, or an object { audio: Blob/File/Buffer, mimeType?, language?, response_format?, timestampGranularities?, prompt?, temperature? }"
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
  formData.append("audio", blob, filename);
  if (extraParams) {
    if (typeof extraParams.language === "string") {
      formData.append("languageCode", String(extraParams.language));
    }
  }

  try {
    const response = await createElizaCloudClient(runtime).routes.postApiV1VoiceSttRaw({
      body: formData,
      timeoutMs: resolveCloudTimeoutMs("ELIZAOS_CLOUD_STT_TIMEOUT_MS", 60_000),
    });

    if (!response.ok) {
      throw new Error(`Failed to transcribe audio: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      text?: string;
      transcript?: string;
    };
    return data.text ?? data.transcript ?? "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`TRANSCRIPTION error: ${message}`);
    throw error;
  }
}
