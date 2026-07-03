import { Hono } from "hono";
import { z } from "zod";
import {
  ApiError,
  failureResponse,
  jsonError,
} from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getVideoProvider } from "@/lib/providers/video/registry";
import {
  calculateVideoGenerationCostFromCatalog,
  getDefaultVideoBillingDimensions,
} from "@/lib/services/ai-pricing";
import {
  getSupportedVideoModelDefinition,
  SUPPORTED_VIDEO_MODEL_IDS,
} from "@/lib/services/ai-pricing-definitions";
import { contentSafetyService } from "@/lib/services/content-safety";
import {
  creditsService,
  InsufficientCreditsError,
} from "@/lib/services/credits";
import { generationsService } from "@/lib/services/generations";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

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

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

function envString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

app.post("/", async (c) => {
  let reservation: Awaited<ReturnType<typeof creditsService.reserve>> | null =
    null;
  // Once the charge is SETTLED, a later (non-critical, post-settle) failure must
  // NOT hit the catch's reconcile(0) — which is non-idempotent and would refund
  // the already-correct charge, giving a free video. Mirrors generate-image.
  let chargeSettled = false;

  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const request = videoRequestSchema.parse(await c.req.json());
    const definition = getSupportedVideoModelDefinition(request.model);
    if (!definition) {
      return jsonError(
        c,
        400,
        `Unsupported video model: ${request.model}`,
        "validation_error",
        {
          supportedModels: SUPPORTED_VIDEO_MODEL_IDS,
        },
      );
    }

    const provider = getVideoProvider(definition.billingSource);
    const apiKeys = {
      FAL_KEY: envString(c.env.FAL_KEY),
      FAL_API_KEY: envString(c.env.FAL_API_KEY),
    };
    if (provider.isConfigured && !provider.isConfigured(apiKeys)) {
      const providerName =
        definition.provider === "fal" ? "Fal" : definition.provider;
      return jsonError(
        c,
        503,
        `${providerName} video generation is not configured`,
        "internal_error",
      );
    }

    await contentSafetyService.assertSafeForPublicUse({
      surface: "media_generation_prompt",
      organizationId: user.organization_id,
      userId: user.id,
      text: [
        `Video prompt: ${request.prompt}`,
        request.referenceUrl
          ? `Reference URL: ${request.referenceUrl}`
          : undefined,
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
      ...(request.voiceControl !== undefined
        ? { voiceControl: request.voiceControl }
        : {}),
      ...(defaults.dimensions.durationSeconds !== undefined
        ? { durationSeconds }
        : {}),
    };
    const cost = await calculateVideoGenerationCostFromCatalog({
      model: request.model,
      billingSource: definition.billingSource,
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
          {
            success: false,
            error: "Insufficient credits",
            required: error.required,
          },
          402,
        );
      }
      throw error;
    }

    const generated = await provider.generate({
      ...request,
      apiKeys,
    });
    if (generated.hasNsfwConcepts?.some(Boolean)) {
      throw new ApiError(
        400,
        "validation_error",
        "Generated video failed safety review",
        {
          surface: "media_generation_output",
          provider: definition.provider,
          model: request.model,
          issues: ["provider_nsfw_signal"],
        },
      );
    }

    await reservation.reconcile(cost.totalCost);
    chargeSettled = true;

    const generation = await generationsService.create({
      organization_id: user.organization_id,
      user_id: user.id,
      type: "video",
      model: request.model,
      provider: definition.provider,
      prompt: request.prompt,
      result: {
        requestId: generated.requestId,
        seed: generated.seed,
        timings: generated.timings,
        billingSource: definition.billingSource,
      },
      status: "completed",
      storage_url: generated.video.url,
      thumbnail_url: generated.video.url,
      file_size: generated.video.file_size
        ? BigInt(generated.video.file_size)
        : undefined,
      mime_type: generated.video.content_type ?? "video/mp4",
      parameters: {
        referenceUrl: request.referenceUrl,
        durationSeconds,
        resolution: request.resolution,
        audio: request.audio,
        voiceControl: request.voiceControl,
      },
      dimensions: {
        width: generated.video.width,
        height: generated.video.height,
        duration: durationSeconds,
      },
      cost: String(cost.totalCost),
      credits: String(cost.totalCost),
      job_id: generated.requestId,
      completed_at: new Date(),
    });

    return c.json({
      success: true,
      id: generation.id,
      requestId: generated.requestId,
      video: generated.video,
      seed: generated.seed,
      timings: generated.timings,
      has_nsfw_concepts: generated.hasNsfwConcepts,
      cost,
    });
  } catch (error) {
    if (reservation && !chargeSettled) {
      await reservation.reconcile(0).catch((reconcileError) => {
        logger.error("[GenerateVideo] Failed to refund reservation", {
          error:
            reconcileError instanceof Error
              ? reconcileError.message
              : String(reconcileError),
        });
      });
    }
    return failureResponse(c, error);
  }
});

app.all("*", (c) =>
  c.json({ success: false, error: "Method not allowed" }, 405),
);

export default app;
