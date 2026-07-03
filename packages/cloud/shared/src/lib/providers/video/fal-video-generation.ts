import { createFalClient } from "@fal-ai/client";
import { getAiProviderConfigurationError } from "../language-model";
import type {
  GeneratedVideo,
  GeneratedVideoObject,
  VideoGenerationRequest,
  VideoProvider,
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

  const video =
    normalizeVideoObject(result.video) ??
    (Array.isArray(result.videos) ? normalizeVideoObject(result.videos[0]) : null);
  if (!video?.url) {
    throw new Error("fal.ai returned no video URL");
  }

  return {
    requestId: stringValue(result.requestId) ?? stringValue(result.request_id) ?? requestId,
    video,
    seed: numberValue(result.seed),
    timings: recordNumberMap(result.timings) ?? null,
    hasNsfwConcepts: booleanArrayValue(result.has_nsfw_concepts),
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

export async function generateFalVideo(request: VideoGenerationRequest): Promise<GeneratedVideo> {
  const key = falKey(request.apiKeys);
  if (!key) {
    throw new Error(getAiProviderConfigurationError());
  }

  let requestId: string | undefined;
  const fal = createFalClient({
    credentials: key,
    suppressLocalCredentialsWarning: true,
  });
  const result = await fal.subscribe(request.model, {
    input: buildFalVideoInput(request),
    onEnqueue: (id) => {
      requestId = id;
    },
  });
  return normalizeFalVideoResult(result, requestId);
}

export const falVideoProvider: VideoProvider = {
  billingSource: "fal",
  isConfigured(apiKeys) {
    return Boolean(falKey(apiKeys));
  },
  generate: generateFalVideo,
  async healthCheck() {
    return true;
  },
};
