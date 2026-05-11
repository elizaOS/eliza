import { createFalClient } from "@fal-ai/client";
import { Hono } from "hono";
import { z } from "zod";
import { ApiError, failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  calculateVideoGenerationCostFromCatalog,
  getDefaultVideoBillingDimensions,
} from "@/lib/services/ai-pricing";
import {
  getSupportedVideoModelDefinition,
  SUPPORTED_VIDEO_MODEL_IDS,
} from "@/lib/services/ai-pricing-definitions";
import { contentSafetyService } from "@/lib/services/content-safety";
import { creditsService, InsufficientCreditsError } from "@/lib/services/credits";
import { generationsService } from "@/lib/services/generations";
import { logger } from "@/lib/utils/logger";
import type { AppEnv, Bindings } from "@/types/cloud-worker-env";

const DEFAULT_VIDEO_MODEL = "fal-ai/veo3";
const MAX_PROMPT_LENGTH = 4000;

const videoRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
  model: z.string().trim().default(DEFAULT_VIDEO_MODEL),
  referenceUrl: z.string().trim().url().optional(),
  durationSeconds: z.coerce.number().int().min(1).max(30).optional(),
  resolution: z.string().trim().max(32).optional(),
  audio: z.boolean().optional(),
  voiceControl: z.boolean().optional(),
});

type VideoRequest = z.infer<typeof videoRequestSchema>;

interface FalVideoObject {
  url?: string;
  width?: number;
  height?: number;
  file_name?: string;
  file_size?: number;
  content_type?: string;
}

interface NormalizedFalVideoResult {
  requestId?: string;
  video: FalVideoObject;
  seed?: number;
  timings?: Record<string, number> | null;
  hasNsfwConcepts?: boolean[];
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

function falKey(env: Bindings): string | null {
  const key = env.FAL_KEY ?? env.FAL_API_KEY;
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

function normalizeVideoObject(value: unknown): FalVideoObject | null {
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

function normalizeFalResult(result: unknown, requestId?: string): NormalizedFalVideoResult {
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

function buildFalInput(request: VideoRequest): Record<string, unknown> {
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

app.post("/", async (c) => {
  let reservation: Awaited<ReturnType<typeof creditsService.reserve>> | null = null;

  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const request = videoRequestSchema.parse(await c.req.json());
    const definition = getSupportedVideoModelDefinition(request.model);
    if (!definition) {
      return jsonError(c, 400, `Unsupported video model: ${request.model}`, "validation_error", {
        supportedModels: SUPPORTED_VIDEO_MODEL_IDS,
      });
    }

    const key = falKey(c.env);
    if (!key) {
      return jsonError(c, 503, "Fal video generation is not configured", "internal_error");
    }

    await contentSafetyService.assertSafeForPublicUse({
      surface: "media_generation_prompt",
      organizationId: user.organization_id,
      userId: user.id,
      text: [
        `Video prompt: ${request.prompt}`,
        request.referenceUrl ? `Reference URL: ${request.referenceUrl}` : undefined,
      ],
      imageUrls: request.referenceUrl ? [request.referenceUrl] : undefined,
      metadata: { type: "video", model: request.model },
    });

    const defaults = getDefaultVideoBillingDimensions(request.model);
    const durationSeconds = request.durationSeconds ?? defaults.durationSeconds;
    const dimensions = {
      ...defaults.dimensions,
      ...(request.resolution ? { resolution: request.resolution } : {}),
      ...(request.audio !== undefined ? { audio: request.audio } : {}),
      ...(request.voiceControl !== undefined ? { voiceControl: request.voiceControl } : {}),
      ...(defaults.dimensions.durationSeconds !== undefined ? { durationSeconds } : {}),
    };
    const cost = await calculateVideoGenerationCostFromCatalog({
      model: request.model,
      billingSource: "fal",
      durationSeconds,
      dimensions,
    });

    try {
      reservation = await creditsService.reserve({
        organizationId: user.organization_id,
        userId: user.id,
        amount: cost.totalCost,
        description: `Video generation: ${request.model}`,
      });
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return c.json(
          { success: false, error: "Insufficient credits", required: error.required },
          402,
        );
      }
      throw error;
    }

    let requestId: string | undefined;
    const fal = createFalClient({
      credentials: key,
      suppressLocalCredentialsWarning: true,
    });
    const result = await fal.subscribe(request.model, {
      input: buildFalInput(request),
      onEnqueue: (id) => {
        requestId = id;
      },
    });
    const normalized = normalizeFalResult(result, requestId);
    if (normalized.hasNsfwConcepts?.some(Boolean)) {
      throw new ApiError(400, "validation_error", "Generated video failed safety review", {
        surface: "media_generation_output",
        provider: definition.provider,
        model: request.model,
        issues: ["provider_nsfw_signal"],
      });
    }

    await reservation.reconcile(cost.totalCost);

    const generation = await generationsService.create({
      organization_id: user.organization_id,
      user_id: user.id,
      type: "video",
      model: request.model,
      provider: definition.provider,
      prompt: request.prompt,
      result: {
        requestId: normalized.requestId,
        seed: normalized.seed,
        timings: normalized.timings,
        billingSource: definition.billingSource,
      },
      status: "completed",
      storage_url: normalized.video.url,
      thumbnail_url: normalized.video.url,
      file_size: normalized.video.file_size ? BigInt(normalized.video.file_size) : undefined,
      mime_type: normalized.video.content_type ?? "video/mp4",
      parameters: {
        referenceUrl: request.referenceUrl,
        durationSeconds,
        resolution: request.resolution,
        audio: request.audio,
        voiceControl: request.voiceControl,
      },
      dimensions: {
        width: normalized.video.width,
        height: normalized.video.height,
        duration: durationSeconds,
      },
      cost: String(cost.totalCost),
      credits: String(cost.totalCost),
      job_id: normalized.requestId,
      completed_at: new Date(),
    });

    return c.json({
      success: true,
      id: generation.id,
      requestId: normalized.requestId,
      video: normalized.video,
      seed: normalized.seed,
      timings: normalized.timings,
      has_nsfw_concepts: normalized.hasNsfwConcepts,
      cost,
    });
  } catch (error) {
    if (reservation) {
      await reservation.reconcile(0).catch((reconcileError) => {
        logger.error("[GenerateVideo] Failed to refund reservation", {
          error: reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
        });
      });
    }
    return failureResponse(c, error);
  }
});

app.all("*", (c) => c.json({ success: false, error: "Method not allowed" }, 405));

export default app;
