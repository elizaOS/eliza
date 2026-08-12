// Defines cloud shared fal audio generation behavior for backend service consumers.
import {
  FalQueueEnqueuedError,
  falQueueOptionsFromApiKeys,
  getFalQueueJobStatus,
  runFalQueueJob,
} from "../fal-queue";
import type {
  AudioGenRequest,
  AudioJobStatus,
  AudioJobStatusRequest,
  AudioProvider,
  GeneratedAudio,
} from "./types";
import { AudioGenerationPendingError } from "./types";

/** Cap the synchronous poll so music routes return pending instead of multi-minute holds (#18436). */
export const DEFAULT_MUSIC_SYNC_TIMEOUT_MS = 45_000;

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

function resolveSyncTimeoutMs(
  options: ReturnType<typeof falQueueOptionsFromApiKeys>,
  kind: AudioGenRequest["kind"],
): number {
  // Music generation is the hang surface in #18436 — keep the sync window short
  // so the route can return 202 pending while the reconcile sweep finishes work.
  // Explicit FAL_QUEUE_TIMEOUT_MS is honored when set, but still capped so a
  // misconfigured 300s/10m timeout cannot recreate multi-minute HTTP holds.
  const configured = options.timeoutMs;
  if (kind === "music") {
    const cap = 90_000;
    if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
      return Math.min(configured, cap);
    }
    return DEFAULT_MUSIC_SYNC_TIMEOUT_MS;
  }
  return configured ?? 10 * 60_000;
}

/**
 * Verifies the upstream state of an enqueued fal audio request. Only reports
 * `failed` on a definitive provider verdict; transport errors propagate so
 * callers keep the credit hold instead of refunding blind.
 */
export async function getFalAudioJobStatus(
  req: AudioJobStatusRequest,
): Promise<AudioJobStatus> {
  const options = falQueueOptionsFromApiKeys(req.apiKeys);
  const status = await getFalQueueJobStatus({
    model: req.model,
    requestId: req.requestId,
    options,
  });
  if (status.state === "pending") return { state: "pending" };
  if (status.state === "failed") return { state: "failed", error: status.error };
  return {
    state: "succeeded",
    result: normalizeFalAudioResult(status.payload, status.requestId),
  };
}

export async function generateFalAudio(request: AudioGenRequest): Promise<GeneratedAudio> {
  const baseOptions = falQueueOptionsFromApiKeys(request.apiKeys);
  const options = {
    ...baseOptions,
    timeoutMs: resolveSyncTimeoutMs(baseOptions, request.kind),
  };
  const input = request.kind === "sfx" ? buildFalSfxInput(request) : buildFalMusicInput(request);

  try {
    const { requestId, payload } = await runFalQueueJob(request.model, input, options);
    return normalizeFalAudioResult(payload, requestId);
  } catch (error) {
    // Any post-enqueue unknown outcome (timeout, status 5xx/abort, result 5xx)
    // carries FalQueueEnqueuedError with requestId. Probe terminal state before
    // letting the route refund. Still-live jobs become AudioGenerationPendingError
    // so credits stay reserved for the reconcile sweep (#18436).
    if (!(error instanceof FalQueueEnqueuedError)) {
      throw error;
    }

    let probe: AudioJobStatus;
    try {
      probe = await getFalAudioJobStatus({
        model: request.model,
        requestId: error.requestId,
        apiKeys: request.apiKeys,
      });
    } catch {
      throw new AudioGenerationPendingError(error.requestId, error.message);
    }
    if (probe.state === "succeeded") {
      return probe.result;
    }
    if (probe.state === "failed") {
      // Verified terminal failure — refunding is safe. Throw a plain Error so
      // the route refund path is not confused with pending settlement.
      throw new Error(probe.error || error.message);
    }
    throw new AudioGenerationPendingError(error.requestId, error.message);
  }
}

export const falAudioProvider: AudioProvider = {
  billingSource: "fal",
  generate: generateFalAudio,
  getJobStatus: getFalAudioJobStatus,
};
