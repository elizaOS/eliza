// Defines cloud shared fal video generation behavior for backend service consumers.
import { ApiError, createFalClient } from "@fal-ai/client";
import { getAiProviderConfigurationError } from "../language-model";
import {
  type GeneratedVideo,
  type GeneratedVideoObject,
  VideoGenerationPendingError,
  type VideoGenerationRequest,
  type VideoJobStatus,
  type VideoJobStatusRequest,
  type VideoProvider,
} from "./types";

function falKey(apiKeys: Record<string, string | undefined>): string | null {
  const key = apiKeys.FAL_KEY ?? apiKeys.FAL_API_KEY;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanArrayValue(value: unknown): boolean[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "boolean")
    ? value
    : undefined;
}

function recordNumberMap(value: unknown): Record<string, number> | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;

  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" && Number.isFinite(item)) {
      out[key] = item;
    }
  }
  return out;
}

function normalizeVideoObject(value: unknown): GeneratedVideoObject | null {
  if (!isRecord(value)) return null;
  const url = stringValue(value.url);
  if (!url) return null;
  return {
    url,
    width: numberValue(value.width),
    height: numberValue(value.height),
    file_name: stringValue(value.file_name),
    file_size: numberValue(value.file_size),
    content_type: stringValue(value.content_type),
  };
}

export function normalizeFalVideoResult(result: unknown, requestId?: string): GeneratedVideo {
  if (!isRecord(result)) {
    throw new Error("fal.ai returned an invalid video response");
  }

  // @fal-ai/client v1 wraps model output as Result<T> = { data, requestId };
  // raw queue payloads carry the fields at the top level. Accept both.
  const envelopeRequestId = stringValue(result.requestId) ?? stringValue(result.request_id);
  const payload = isRecord(result.data) ? result.data : result;

  const video =
    normalizeVideoObject(payload.video) ??
    (Array.isArray(payload.videos) ? normalizeVideoObject(payload.videos[0]) : null);
  if (!video?.url) {
    throw new Error("fal.ai returned no video URL");
  }

  return {
    requestId:
      stringValue(payload.requestId) ??
      stringValue(payload.request_id) ??
      envelopeRequestId ??
      requestId,
    video,
    seed: numberValue(payload.seed),
    timings: recordNumberMap(payload.timings) ?? null,
    hasNsfwConcepts: booleanArrayValue(payload.has_nsfw_concepts),
  };
}

export function buildFalVideoInput(request: VideoGenerationRequest): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: request.prompt };
  if (request.referenceUrl) {
    input.image_url = request.referenceUrl;
  }
  if (request.durationSeconds) {
    input.duration = request.durationSeconds;
    input.duration_seconds = request.durationSeconds;
  }
  if (request.resolution) {
    input.resolution = request.resolution;
  }
  if (request.audio !== undefined) {
    input.audio = request.audio;
    input.generate_audio = request.audio;
  }
  if (request.voiceControl !== undefined) {
    input.voice_control = request.voiceControl;
  }
  return input;
}

function falClient(apiKeys: Record<string, string | undefined>) {
  const key = falKey(apiKeys);
  if (!key) {
    throw new Error(getAiProviderConfigurationError());
  }
  return createFalClient({
    credentials: key,
    suppressLocalCredentialsWarning: true,
  });
}

/**
 * Verifies the upstream state of an enqueued fal.ai request. Only reports
 * `failed` on a definitive provider verdict (unknown request id, or a
 * completed job whose result endpoint rejects the render); transport errors
 * propagate so callers keep the credit hold instead of refunding blind.
 */
export async function getFalVideoJobStatus(req: VideoJobStatusRequest): Promise<VideoJobStatus> {
  const fal = falClient(req.apiKeys);

  let status: Awaited<ReturnType<typeof fal.queue.status>>;
  try {
    status = await fal.queue.status(req.model, { requestId: req.requestId });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return {
        state: "failed",
        error: `fal.ai does not know request ${req.requestId}`,
      };
    }
    throw error;
  }

  if (status.status !== "COMPLETED") {
    return { state: "pending" };
  }

  let result: unknown;
  try {
    result = await fal.queue.result(req.model, { requestId: req.requestId });
  } catch (error) {
    // A COMPLETED job whose result endpoint answers with a definitive client
    // error is a terminally failed render (fal serves render errors through
    // the result endpoint). Anything else is a transport fault — propagate.
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      return { state: "failed", error: error.message };
    }
    throw error;
  }
  return { state: "succeeded", result: normalizeFalVideoResult(result, req.requestId) };
}

export async function generateFalVideo(request: VideoGenerationRequest): Promise<GeneratedVideo> {
  const fal = falClient(request.apiKeys);

  let requestId: string | undefined;
  try {
    const result = await fal.subscribe(request.model, {
      input: buildFalVideoInput(request),
      onEnqueue: (id) => {
        requestId = id;
      },
    });
    return normalizeFalVideoResult(result, requestId);
  } catch (error) {
    if (!requestId) {
      throw error;
    }
    // The job is already enqueued upstream; a poll/transport failure here does
    // NOT mean the render died — fal may still complete it and bill the
    // platform. Verify the terminal state before letting the route refund the
    // credit hold (#11862).
    let probe: VideoJobStatus;
    try {
      probe = await getFalVideoJobStatus({
        model: request.model,
        requestId,
        apiKeys: request.apiKeys,
      });
    } catch {
      throw new VideoGenerationPendingError(
        requestId,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (probe.state === "succeeded") {
      return probe.result;
    }
    if (probe.state === "failed") {
      // Verified terminal failure — refunding is safe.
      throw error;
    }
    throw new VideoGenerationPendingError(
      requestId,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export const falVideoProvider: VideoProvider = {
  billingSource: "fal",
  isConfigured(apiKeys) {
    return Boolean(falKey(apiKeys));
  },
  generate: generateFalVideo,
  getJobStatus: getFalVideoJobStatus,
  async healthCheck() {
    return true;
  },
};
