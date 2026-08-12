// Defines cloud shared fal audio generation behavior for backend service consumers.
import {
  FalQueueTimeoutError,
  falQueueOptionsFromApiKeys,
  getFalQueueResult,
  runFalQueueJob,
} from "../fal-queue";
import {
  type AudioGenRequest,
  type AudioJobStatus,
  type AudioJobStatusRequest,
  AudioGenerationPendingError,
  type AudioProvider,
  type GeneratedAudio,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface AudioObject {
  url: string;
  fileName?: string;
  fileSize?: number;
  contentType?: string;
}

function normalizeAudioObject(value: unknown): AudioObject | null {
  const directUrl = stringValue(value);
  if (directUrl) {
    return { url: directUrl };
  }
  if (!isRecord(value)) return null;
  const url =
    stringValue(value.url) ??
    stringValue(value.audio_url) ??
    stringValue(value.output_url) ??
    stringValue(value.file_url);
  if (!url) return null;
  return {
    url,
    fileName: stringValue(value.file_name),
    fileSize: numberValue(value.file_size),
    contentType: stringValue(value.content_type),
  };
}

export function normalizeFalAudioResult(
  result: Record<string, unknown>,
  requestId?: string,
): GeneratedAudio {
  const direct =
    normalizeAudioObject(result.audio) ??
    normalizeAudioObject(result.audio_file) ??
    normalizeAudioObject(result.music) ??
    normalizeAudioObject(result.file) ??
    normalizeAudioObject(result.output) ??
    normalizeAudioObject(result);
  const fromArray = Array.isArray(result.audios)
    ? normalizeAudioObject(result.audios[0])
    : Array.isArray(result.data)
      ? normalizeAudioObject(result.data[0])
      : null;
  const audio = direct ?? fromArray;
  if (!audio) {
    throw new Error("fal returned no audio URL");
  }

  return {
    source: "hosted",
    url: audio.url,
    fileName: audio.fileName,
    fileSize: audio.fileSize,
    contentType: audio.contentType,
    requestId: stringValue(result.requestId) ?? stringValue(result.request_id) ?? requestId,
    status: stringValue(result.status),
    raw: result,
  };
}

export function buildFalMusicInput(request: AudioGenRequest): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: request.prompt };

  if (request.lyrics !== undefined) input.lyrics = request.lyrics;
  if (request.instrumental !== undefined) input.is_instrumental = request.instrumental;
  if (request.lyricsOptimizer !== undefined) {
    input.lyrics_optimizer = request.lyricsOptimizer;
  } else if (!request.lyrics && request.instrumental !== true) {
    input.lyrics_optimizer = true;
  }
  if (request.referenceUrl) {
    input.audio_url = request.referenceUrl;
    input.reference_audio_url = request.referenceUrl;
  }
  if (request.durationSeconds) {
    input.duration = request.durationSeconds;
    input.duration_seconds = request.durationSeconds;
    input.seconds_total = request.durationSeconds;
  }
  if (request.audioSettings) {
    input.audio_setting = {
      ...(request.audioSettings.sampleRate
        ? { sample_rate: request.audioSettings.sampleRate }
        : {}),
      ...(request.audioSettings.bitrate ? { bitrate: request.audioSettings.bitrate } : {}),
      ...(request.audioSettings.format ? { format: request.audioSettings.format } : {}),
    };
  }

  return { ...input, ...(request.extraInput ?? {}) };
}

export function buildFalSfxInput(request: AudioGenRequest): Record<string, unknown> {
  // Stable Audio-style text-to-audio input: prompt + total seconds.
  const input: Record<string, unknown> = { prompt: request.prompt };
  if (request.durationSeconds) {
    input.seconds_total = request.durationSeconds;
  }
  if (request.seed !== undefined) {
    input.seed = request.seed;
  }
  return { ...input, ...(request.extraInput ?? {}) };
}

export async function generateFalAudio(request: AudioGenRequest): Promise<GeneratedAudio> {
  const options = falQueueOptionsFromApiKeys(request.apiKeys);
  const input = request.kind === "sfx" ? buildFalSfxInput(request) : buildFalMusicInput(request);
  try {
    const { requestId, payload } = await runFalQueueJob(request.model, input, options);
    return normalizeFalAudioResult(payload, requestId);
  } catch (error) {
    // The poll window expired with the upstream job still IN_QUEUE or
    // IN_PROGRESS. The enqueue already succeeded — fal may still complete the
    // render and bill the platform. The route must verify the terminal state
    // before refunding the credit hold (#18436), mirroring the video pending
    // flow (#11862).
    if (error instanceof FalQueueTimeoutError && error.requestId) {
      throw new AudioGenerationPendingError(
        error.requestId,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}

/**
 * Verifies the upstream state of an enqueued fal audio request. Only reports
 * `failed` on a definitive provider verdict; transport errors propagate so
 * callers keep the credit hold instead of refunding blind.
 *
 * The fal queue status endpoint is accessed via the standard
 * `/requests/{requestId}/status` path and the result endpoint via
 * `/requests/{requestId}`. A 404 means the upstream no longer knows the job
 * (stale, purged) — a verified failure where refunding is safe.
 */
export async function getFalAudioJobStatus(req: AudioJobStatusRequest): Promise<AudioJobStatus> {
  const options = falQueueOptionsFromApiKeys(req.apiKeys);
  const base = new URL(options.baseUrl ?? "https://queue.fal.run");
  const basepath = base.pathname.replace(/\/+$/, "");

  const statusUrl = new URL(
    `${basepath}/requests/${req.requestId}/status`.replace(/^\/+/, "/"),
    base.origin,
  );

  let statusResponse: Response;
  try {
    statusResponse = await fetch(statusUrl, {
      headers: {
        Authorization: `Key ${options.apiKey}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // Transport failure — the upstream state is UNKNOWN; propagate so the
    // caller keeps the credit hold.
    throw new Error(`fal audio status probe failed for request ${req.requestId}`);
  }

  if (statusResponse.status === 404) {
    return {
      state: "failed",
      error: `fal does not know request ${req.requestId}`,
    };
  }

  const statusPayload = (await statusResponse.json().catch(() => null)) as unknown;
  if (!isRecord(statusPayload)) {
    throw new Error(
      `fal audio status returned a non-JSON-object response for ${req.requestId}`,
    );
  }
  if (!statusResponse.ok) {
    throw new Error(`fal audio status failed (${statusResponse.status}) for ${req.requestId}`);
  }

  const status = stringValue(statusPayload.status);
  if (status !== "COMPLETED") {
    return { state: "pending" };
  }

  // COMPLETED — fetch the result payload to confirm audio is present.
  const responseUrl = new URL(
    `${basepath}/requests/${req.requestId}`.replace(/^\/+/, "/"),
    base.origin,
  );
  let resultPayload: Record<string, unknown>;
  try {
    const { payload } = await getFalQueueResult(responseUrl.toString(), options);
    resultPayload = payload;
  } catch {
    // A COMPLETED job whose result endpoint fails is treated as pending — the
    // render may still be finalizing its output. Do not refund blind.
    return { state: "pending" };
  }
  try {
    return { state: "succeeded", result: normalizeFalAudioResult(resultPayload, req.requestId) };
  } catch (normalizeError) {
    // COMPLETED but the payload has no audio — the render failed at the model
    // level even though the queue job is technically done.
    return {
      state: "failed",
      error: normalizeError instanceof Error ? normalizeError.message : String(normalizeError),
    };
  }
}

export const falAudioProvider: AudioProvider = {
  billingSource: "fal",
  generate: generateFalAudio,
  getJobStatus: getFalAudioJobStatus,
};
