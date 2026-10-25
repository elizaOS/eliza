/** Implements Atlas Cloud video submission, polling, and status reconciliation. */
import { getAiProviderConfigurationError } from "../language-model";
import type {
  GeneratedVideo,
  GeneratedVideoObject,
  VideoGenerationRequest,
  VideoJobStatus,
  VideoJobStatusRequest,
  VideoProvider,
} from "./types";
import {
  VideoGenerationPendingError,
  VideoGenerationSubmissionUnknownError,
  VideoGenerationTerminalError,
} from "./types";

const ATLAS_POLL_INTERVAL_MS = 2_000;
const ATLAS_POLL_TIMEOUT_MS = 180_000;
const ATLAS_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Bound every Atlas Cloud REST hop so a hung or rate-limited API cannot pin
 * the video-generation worker indefinitely. A caller-provided abort signal
 * wins.
 */
export function atlasFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = ATLAS_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  return fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
}

function atlasBaseUrl(request: VideoGenerationRequest): string {
  return (request.apiKeys.ATLASCLOUD_BASE_URL || "https://api.atlascloud.ai").replace(/\/+$/, "");
}

function atlasPollUrl(baseUrl: string, predictionId: string, candidate?: string): string {
  const canonical = `${baseUrl}/api/v1/model/prediction/${predictionId}`;
  if (!candidate) return canonical;
  try {
    const base = new URL(baseUrl);
    const resolved = new URL(candidate, `${baseUrl}/`);
    return resolved.protocol === "https:" && resolved.origin === base.origin
      ? resolved.toString()
      : canonical;
  } catch {
    // error-policy:J3 Provider response URLs are untrusted; an invalid value
    // falls back to the canonical same-provider prediction endpoint.
    return canonical;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type AtlasJsonResult =
  | { kind: "parsed"; payload: Record<string, unknown> }
  | { kind: "invalid"; error: unknown };

async function parseAtlasJson(response: Response): Promise<AtlasJsonResult> {
  try {
    const payload: unknown = await response.json();
    return isRecord(payload)
      ? { kind: "parsed", payload }
      : {
          kind: "invalid",
          error: new Error("Atlas Cloud returned a non-object JSON payload"),
        };
  } catch (error) {
    // error-policy:J3 provider JSON is untrusted input; callers receive an
    // explicit invalid result and decide using the known HTTP/job state.
    return { kind: "invalid", error };
  }
}

interface AtlasPrediction {
  id?: string;
  status?: string;
  outputs?: unknown;
  error?: string;
  urls?: { get?: string };
}

function parsePrediction(payload: Record<string, unknown>): AtlasPrediction {
  const data = isRecord(payload.data) ? payload.data : payload;
  return {
    id: stringValue(data.id),
    status: stringValue(data.status),
    outputs: data.outputs,
    error: stringValue(data.error),
    urls: isRecord(data.urls) ? { get: stringValue(data.urls.get) } : undefined,
  };
}

function normalizeVideoObject(value: unknown): GeneratedVideoObject | null {
  if (typeof value === "string" && value.trim()) {
    return { url: value.trim(), content_type: "video/mp4" };
  }
  if (!isRecord(value)) return null;
  const url = stringValue(value.url);
  if (!url) return null;
  return {
    url,
    width: numberValue(value.width),
    height: numberValue(value.height),
    file_name: stringValue(value.file_name) ?? stringValue(value.filename),
    file_size: numberValue(value.file_size) ?? numberValue(value.size),
    content_type: stringValue(value.content_type) ?? stringValue(value.mime_type) ?? "video/mp4",
  };
}

export function firstAtlasVideoOutput(outputs: unknown): GeneratedVideoObject | null {
  if (!Array.isArray(outputs)) return null;
  for (const output of outputs) {
    const video = normalizeVideoObject(output);
    if (video) return video;
  }
  return null;
}

export function buildAtlasVideoInput(request: VideoGenerationRequest): Record<string, unknown> {
  const input: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
  };
  if (request.referenceUrl) {
    input.image_url = request.referenceUrl;
    input.image = request.referenceUrl;
  }
  if (request.durationSeconds) {
    input.duration = request.durationSeconds;
  }
  if (request.resolution) {
    input.resolution = request.resolution;
  }
  // Atlas defaults audio ON server-side; billing prices the `audio: false` shape,
  // so always pin the request to the priced default unless the caller opts in.
  input.generate_audio = request.audio ?? false;
  return input;
}

const TERMINAL_OK = new Set(["completed", "succeeded", "success"]);
const TERMINAL_FAIL = new Set(["failed", "error", "canceled", "cancelled"]);

export async function generateAtlasCloudVideo(
  request: VideoGenerationRequest,
): Promise<GeneratedVideo> {
  const apiKey = request.apiKeys.ATLASCLOUD_API_KEY;
  if (!apiKey) {
    throw new Error(getAiProviderConfigurationError());
  }

  const baseUrl = atlasBaseUrl(request);
  const authHeader = { authorization: `Bearer ${apiKey}` };
  let submitResponse: Response;
  try {
    submitResponse = await atlasFetch(`${baseUrl}/api/v1/model/generateVideo`, {
      method: "POST",
      headers: { ...authHeader, "content-type": "application/json" },
      body: JSON.stringify(buildAtlasVideoInput(request)),
    });
  } catch (error) {
    // error-policy:J1 submission transport is the provider boundary; without
    // a response or job id the paid-work state is explicitly unknown.
    throw new VideoGenerationSubmissionUnknownError(
      error instanceof Error ? error.message : String(error),
      error,
    );
  }

  const submitJson = await parseAtlasJson(submitResponse);
  const submitPayload = submitJson.kind === "parsed" ? submitJson.payload : undefined;
  if (!submitResponse.ok) {
    const message =
      stringValue(submitPayload?.msg) ??
      stringValue(submitPayload?.message) ??
      `Atlas video generation failed: ${submitResponse.status}`;
    const providerCause = Object.assign(new Error(message), {
      status: submitResponse.status,
      ...(submitJson.kind === "invalid" ? { cause: submitJson.error } : {}),
    });
    // Atlas returns the prediction id only in a 2xx body; an error status
    // (4xx or 5xx) means no paid prediction was created, so releasing the
    // hold and trying the next provider is safe.
    throw new VideoGenerationTerminalError(message, providerCause);
  }
  if (submitJson.kind === "invalid") {
    throw new VideoGenerationSubmissionUnknownError(
      "Atlas video provider returned an invalid submission response",
      submitJson.error,
    );
  }

  const submitted = parsePrediction(submitJson.payload);
  const inlineVideo = firstAtlasVideoOutput(submitted.outputs);
  if (inlineVideo) {
    return { requestId: submitted.id, video: inlineVideo, timings: null };
  }

  const predictionId = submitted.id;
  if (!predictionId) {
    throw new VideoGenerationSubmissionUnknownError(
      "Atlas video provider returned no prediction id",
    );
  }
  const pollUrl = atlasPollUrl(baseUrl, predictionId, submitted.urls?.get);
  const deadline = Date.now() + ATLAS_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, ATLAS_POLL_INTERVAL_MS));

    let pollResponse: Response;
    try {
      // Following a redirect would re-send the bearer credential wherever the
      // provider response points, so a 3xx is returned as-is and settles as a
      // pending provider state through the non-ok branch below.
      pollResponse = await atlasFetch(pollUrl, { headers: authHeader, redirect: "manual" });
    } catch (error) {
      // error-policy:J1 a known prediction id makes poll transport failure a
      // pending provider state that the durable reconciliation path can query.
      throw new VideoGenerationPendingError(
        predictionId,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!pollResponse.ok) {
      throw new VideoGenerationPendingError(
        predictionId,
        `Atlas prediction poll failed: ${pollResponse.status}`,
      );
    }
    const pollJson = await parseAtlasJson(pollResponse);
    if (pollJson.kind === "invalid") {
      throw new VideoGenerationPendingError(
        predictionId,
        "Atlas prediction poll returned an invalid response",
      );
    }

    const prediction = parsePrediction(pollJson.payload);
    const status = (prediction.status ?? "").toLowerCase();
    if (TERMINAL_FAIL.has(status)) {
      throw new VideoGenerationTerminalError(
        `Atlas video generation failed${prediction.error ? `: ${prediction.error}` : ""}`,
      );
    }
    if (TERMINAL_OK.has(status)) {
      const video = firstAtlasVideoOutput(prediction.outputs);
      if (!video) {
        throw new VideoGenerationTerminalError(
          "Atlas video provider completed without an output video",
        );
      }
      return { requestId: prediction.id ?? predictionId, video, timings: null };
    }
  }

  throw new VideoGenerationPendingError(predictionId, "Atlas video generation timed out");
}

export async function getAtlasCloudVideoJobStatus(
  req: VideoJobStatusRequest,
): Promise<VideoJobStatus> {
  const apiKey = req.apiKeys.ATLASCLOUD_API_KEY;
  if (!apiKey) {
    throw new Error(getAiProviderConfigurationError());
  }

  const baseUrl = (req.apiKeys.ATLASCLOUD_BASE_URL || "https://api.atlascloud.ai").replace(
    /\/+$/,
    "",
  );
  // Same credential-containment rule as the generation poll: never follow a
  // redirect with the bearer header; a 3xx throws below and the reconcile
  // boundary retries the probe on its next tick.
  const response = await atlasFetch(`${baseUrl}/api/v1/model/prediction/${req.requestId}`, {
    headers: { authorization: `Bearer ${apiKey}` },
    redirect: "manual",
  });
  if (response.status === 404) {
    return {
      state: "failed",
      error: `Atlas Cloud does not know request ${req.requestId}`,
    };
  }
  if (!response.ok) {
    throw new Error(`Atlas prediction status failed: ${response.status}`);
  }

  const responseJson = await parseAtlasJson(response);
  if (responseJson.kind === "invalid") {
    throw new Error("Atlas prediction status returned an invalid response", {
      cause: responseJson.error,
    });
  }

  const prediction = parsePrediction(responseJson.payload);
  const status = (prediction.status ?? "").toLowerCase();
  if (TERMINAL_FAIL.has(status)) {
    return {
      state: "failed",
      error: prediction.error ?? "Atlas Cloud reported a terminal video generation failure",
    };
  }
  if (!TERMINAL_OK.has(status)) {
    return { state: "pending" };
  }

  const video = firstAtlasVideoOutput(prediction.outputs);
  if (!video) {
    return {
      state: "failed",
      error: "Atlas Cloud completed without an output video",
    };
  }
  return {
    state: "succeeded",
    result: { requestId: prediction.id ?? req.requestId, video, timings: null },
  };
}

export const atlasCloudVideoProvider: VideoProvider = {
  billingSource: "atlascloud",
  isConfigured(apiKeys) {
    return (
      typeof apiKeys.ATLASCLOUD_API_KEY === "string" && apiKeys.ATLASCLOUD_API_KEY.trim() !== ""
    );
  },
  generate: generateAtlasCloudVideo,
  getJobStatus: getAtlasCloudVideoJobStatus,
  async healthCheck() {
    return true;
  },
};
