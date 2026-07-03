import { getAiProviderConfigurationError } from "../language-model";
import type {
  GeneratedVideo,
  GeneratedVideoObject,
  VideoGenerationRequest,
  VideoJobStatus,
  VideoJobStatusRequest,
  VideoProvider,
} from "./types";

const ATLAS_POLL_INTERVAL_MS = 2_000;
const ATLAS_POLL_TIMEOUT_MS = 180_000;

function atlasBaseUrl(apiKeys: Record<string, string | undefined>): string {
  return (apiKeys.ATLASCLOUD_BASE_URL || "https://api.atlascloud.ai").replace(/\/+$/, "");
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

function atlasApiKey(apiKeys: Record<string, string | undefined>): string {
  const apiKey = apiKeys.ATLASCLOUD_API_KEY;
  if (!apiKey) {
    throw new Error(getAiProviderConfigurationError());
  }
  return apiKey;
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => ({}));
  return isRecord(payload) ? payload : {};
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

export async function getAtlasCloudVideoJobStatus(
  request: VideoJobStatusRequest,
): Promise<VideoJobStatus> {
  const apiKey = atlasApiKey(request.apiKeys);
  const baseUrl = atlasBaseUrl(request.apiKeys);
  const pollResponse = await fetch(`${baseUrl}/api/v1/model/prediction/${request.requestId}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const pollPayload = await readJsonRecord(pollResponse);

  if (pollResponse.status === 404) {
    return {
      state: "failed",
      error: `Atlas Cloud does not know request ${request.requestId}`,
    };
  }
  if (!pollResponse.ok) {
    throw new Error(`Atlas prediction status failed: ${pollResponse.status}`);
  }

  const prediction = parsePrediction(pollPayload);
  const status = (prediction.status ?? "").toLowerCase();
  if (TERMINAL_FAIL.has(status)) {
    return {
      state: "failed",
      error: prediction.error ?? `Atlas Cloud request ${request.requestId} failed`,
    };
  }
  if (!TERMINAL_OK.has(status)) {
    return { state: "pending" };
  }

  const video = firstAtlasVideoOutput(prediction.outputs);
  if (!video) {
    return {
      state: "failed",
      error: "Atlas video provider completed without an output video",
    };
  }
  return {
    state: "succeeded",
    result: { requestId: prediction.id ?? request.requestId, video, timings: null },
  };
}

export async function generateAtlasCloudVideo(
  request: VideoGenerationRequest,
): Promise<GeneratedVideo> {
  const apiKey = atlasApiKey(request.apiKeys);
  const baseUrl = atlasBaseUrl(request.apiKeys);
  const authHeader = { authorization: `Bearer ${apiKey}` };
  const submitResponse = await fetch(`${baseUrl}/api/v1/model/generateVideo`, {
    method: "POST",
    headers: { ...authHeader, "content-type": "application/json" },
    body: JSON.stringify(buildAtlasVideoInput(request)),
  });

  const submitPayload = await readJsonRecord(submitResponse);
  if (!submitResponse.ok) {
    const message =
      stringValue(submitPayload.msg) ??
      stringValue(submitPayload.message) ??
      `Atlas video generation failed: ${submitResponse.status}`;
    throw new Error(message);
  }

  const submitted = parsePrediction(submitPayload);
  const inlineVideo = firstAtlasVideoOutput(submitted.outputs);
  if (inlineVideo) {
    return { requestId: submitted.id, video: inlineVideo, timings: null };
  }

  const predictionId = submitted.id;
  if (!predictionId) {
    throw new Error("Atlas video provider returned no prediction id");
  }
  const pollUrl = submitted.urls?.get ?? `${baseUrl}/api/v1/model/prediction/${predictionId}`;
  const deadline = Date.now() + ATLAS_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, ATLAS_POLL_INTERVAL_MS));

    const pollResponse = await fetch(pollUrl, { headers: authHeader });
    const pollPayload = await readJsonRecord(pollResponse);
    if (!pollResponse.ok) {
      throw new Error(`Atlas prediction poll failed: ${pollResponse.status}`);
    }

    const prediction = parsePrediction(pollPayload);
    const status = (prediction.status ?? "").toLowerCase();
    if (TERMINAL_FAIL.has(status)) {
      throw new Error(
        `Atlas video generation failed${prediction.error ? `: ${prediction.error}` : ""}`,
      );
    }
    if (TERMINAL_OK.has(status)) {
      const video = firstAtlasVideoOutput(prediction.outputs);
      if (!video) {
        throw new Error("Atlas video provider completed without an output video");
      }
      return { requestId: prediction.id ?? predictionId, video, timings: null };
    }
  }

  throw new Error("Atlas video generation timed out");
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
