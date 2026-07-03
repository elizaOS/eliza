import { Hono } from "hono";
import { z } from "zod";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getAudioProvider } from "@/lib/providers/audio/registry";
import { calculateMusicGenerationCostFromCatalog } from "@/lib/services/ai-pricing";
import {
  getSupportedMusicModelDefinition,
  SUPPORTED_MUSIC_MODEL_IDS,
} from "@/lib/services/ai-pricing-definitions";
import { contentSafetyService } from "@/lib/services/content-safety";
import {
  creditsService,
  InsufficientCreditsError,
} from "@/lib/services/credits";
import { generationsService } from "@/lib/services/generations";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const DEFAULT_MUSIC_MODEL = "fal-ai/minimax-music/v2.6";
const MAX_PROMPT_LENGTH = 4100;
const MAX_LYRICS_LENGTH = 3500;

const audioFormatSchema = z.enum(["mp3", "wav", "pcm", "flac"]).optional();
const audioSampleRateSchema = z
  .enum(["16000", "24000", "32000", "44100"])
  .optional();
const audioBitrateSchema = z
  .enum(["32000", "64000", "128000", "256000"])
  .optional();

const musicRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
  model: z.string().trim().default(DEFAULT_MUSIC_MODEL),
  provider: z.enum(["fal", "elevenlabs", "suno"]).optional(),
  lyrics: z.string().max(MAX_LYRICS_LENGTH).optional(),
  lyricsOptimizer: z.boolean().optional(),
  instrumental: z.boolean().optional(),
  durationSeconds: z.coerce.number().int().min(3).max(600).optional(),
  referenceUrl: z.string().trim().url().optional(),
  seed: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
  outputFormat: z.string().trim().max(64).optional(),
  audio: z
    .object({
      format: audioFormatSchema,
      sampleRate: audioSampleRateSchema,
      bitrate: audioBitrateSchema,
    })
    .strict()
    .optional(),
  extraInput: z.record(z.string(), z.unknown()).optional(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  let reservation: Awaited<ReturnType<typeof creditsService.reserve>> | null =
    null;
  // Once the charge is SETTLED, a later (non-critical, post-settle) failure must
  // NOT hit the catch's reconcile(0) — which is non-idempotent and would refund
  // the already-correct charge, giving free music. Mirrors generate-image.
  let chargeSettled = false;

  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const request = musicRequestSchema.parse(await c.req.json());
    const definition = getSupportedMusicModelDefinition(request.model);
    if (!definition) {
      return jsonError(
        c,
        400,
        `Unsupported music model: ${request.model}`,
        "validation_error",
        {
          supportedModels: SUPPORTED_MUSIC_MODEL_IDS,
        },
      );
    }

    const provider = request.provider ?? definition.provider;
    if (provider !== definition.provider) {
      return jsonError(
        c,
        400,
        `Model ${request.model} is served by ${definition.provider}, not ${provider}`,
        "validation_error",
      );
    }
    if (provider === "fal" && request.prompt.length > 2000) {
      return jsonError(
        c,
        400,
        "Fal music prompts must be 2000 characters or fewer",
        "validation_error",
      );
    }

    await contentSafetyService.assertSafeForPublicUse({
      surface: "media_generation_prompt",
      organizationId: user.organization_id,
      userId: user.id,
      text: [
        `Music prompt: ${request.prompt}`,
        request.lyrics ? `Lyrics: ${request.lyrics}` : undefined,
        request.referenceUrl
          ? `Reference URL: ${request.referenceUrl}`
          : undefined,
      ],
      metadata: { type: "music", model: request.model, provider },
    });

    const durationSeconds =
      request.durationSeconds ?? definition.defaultParameters.durationSeconds;
    const cost = await calculateMusicGenerationCostFromCatalog({
      model: request.model,
      provider: definition.provider,
      billingSource: definition.billingSource,
      durationSeconds,
      dimensions: {
        ...(durationSeconds ? { durationSeconds } : {}),
        ...(request.instrumental !== undefined
          ? { instrumental: request.instrumental }
          : {}),
      },
    });

    try {
      reservation = await creditsService.reserve({
        organizationId: user.organization_id,
        userId: user.id,
        amount: cost.totalCost,
        description: `Music generation: ${request.model}`,
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

    const normalized = await getAudioProvider(provider).generate({
      env: c.env,
      request,
      user,
    });

    await reservation.reconcile(cost.totalCost);
    chargeSettled = true;

    const generation = await generationsService.create({
      organization_id: user.organization_id,
      user_id: user.id,
      type: "music",
      model: request.model,
      provider: definition.provider,
      prompt: request.prompt,
      result: {
        requestId: normalized.requestId,
        status: normalized.status,
        billingSource: definition.billingSource,
        raw: normalized.raw,
      },
      status: "completed",
      storage_url: normalized.audio.url,
      thumbnail_url: null,
      file_size: normalized.audio.file_size
        ? BigInt(normalized.audio.file_size)
        : undefined,
      mime_type: normalized.audio.content_type ?? "audio/mpeg",
      parameters: {
        durationSeconds,
        hasLyrics: Boolean(request.lyrics),
        lyricsOptimizer: request.lyricsOptimizer,
        instrumental: request.instrumental,
        referenceUrl: request.referenceUrl,
        outputFormat: request.outputFormat,
      },
      dimensions: {
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
      status: normalized.status ?? "completed",
      music: normalized.audio,
      cost,
    });
  } catch (error) {
    if (reservation && !chargeSettled) {
      await reservation.reconcile(0).catch((reconcileError) => {
        logger.error("[GenerateMusic] Failed to refund reservation", {
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
