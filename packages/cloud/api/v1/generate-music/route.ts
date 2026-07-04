import { Hono } from "hono";
import { z } from "zod";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getAudioProvider } from "@/lib/providers/audio/registry";
import type { GeneratedAudio } from "@/lib/providers/audio/types";
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
import { putPublicObject } from "@/lib/storage/r2-public-object";
import { logger } from "@/lib/utils/logger";
import type { AppEnv, Bindings } from "@/types/cloud-worker-env";

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

function envString(env: Bindings, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function providerConfigured(env: Bindings, provider: string): boolean {
  if (provider === "fal") {
    return Boolean(envString(env, "FAL_KEY") ?? envString(env, "FAL_API_KEY"));
  }
  if (provider === "elevenlabs") {
    return Boolean(envString(env, "ELEVENLABS_API_KEY"));
  }
  return Boolean(envString(env, "SUNO_API_KEY"));
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("L16") || contentType.includes("pcm")) return "pcm";
  if (contentType.includes("basic")) return "ulaw";
  return "mp3";
}

interface StoredAudio {
  url: string;
  file_name?: string;
  file_size?: number;
  content_type?: string;
}

/**
 * Byte results (ElevenLabs streams the file body) are persisted to R2 here so
 * providers stay storage-free; hosted results pass through unchanged.
 */
async function storeGeneratedAudio(
  env: Bindings,
  generated: GeneratedAudio,
  keyPrefix: string,
  customMetadata: Record<string, string>,
): Promise<StoredAudio> {
  if (generated.source === "hosted") {
    return {
      url: generated.url,
      file_name: generated.fileName,
      file_size: generated.fileSize,
      content_type: generated.contentType,
    };
  }

  if (!env.BLOB) {
    throw new Error("R2 storage is not configured");
  }
  const ext = extensionForContentType(generated.contentType);
  const key = `${keyPrefix}/${crypto.randomUUID()}.${ext}`;
  const body = generated.bytes.buffer.slice(
    generated.bytes.byteOffset,
    generated.bytes.byteOffset + generated.bytes.byteLength,
  ) as ArrayBuffer;
  const stored = await putPublicObject(env, {
    key,
    body,
    contentType: generated.contentType,
    customMetadata,
  });
  return {
    url: stored.url,
    file_name: key.split("/").at(-1),
    file_size: generated.bytes.byteLength,
    content_type: generated.contentType,
  };
}

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
    if (
      definition.durationControl === "unsupported" &&
      request.durationSeconds !== undefined
    ) {
      return jsonError(
        c,
        400,
        `Model ${request.model} does not support durationSeconds; omit durationSeconds and bill it as a fixed-price generation`,
        "validation_error",
      );
    }
    if (!providerConfigured(c.env, provider)) {
      return jsonError(
        c,
        503,
        `${provider} music generation is not configured`,
        "internal_error",
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
      definition.durationControl === "supported"
        ? (request.durationSeconds ??
          definition.defaultParameters.durationSeconds)
        : undefined;
    const cost = await calculateMusicGenerationCostFromCatalog({
      model: request.model,
      provider: definition.provider,
      billingSource: definition.billingSource,
      durationSeconds,
      dimensions: {
        ...(definition.durationControl === "supported" && durationSeconds
          ? { durationSeconds }
          : {}),
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

    const generated = await getAudioProvider(definition.billingSource).generate(
      {
        kind: "music",
        model: request.model,
        prompt: request.prompt,
        lyrics: request.lyrics,
        lyricsOptimizer: request.lyricsOptimizer,
        instrumental: request.instrumental,
        durationSeconds,
        referenceUrl: request.referenceUrl,
        seed: request.seed,
        outputFormat: request.outputFormat,
        audioSettings: request.audio,
        extraInput: request.extraInput,
        apiKeys: {
          FAL_KEY: envString(c.env, "FAL_KEY"),
          FAL_API_KEY: envString(c.env, "FAL_API_KEY"),
          FAL_QUEUE_BASE_URL: envString(c.env, "FAL_QUEUE_BASE_URL"),
          FAL_QUEUE_POLL_INTERVAL_MS: envString(
            c.env,
            "FAL_QUEUE_POLL_INTERVAL_MS",
          ),
          FAL_QUEUE_TIMEOUT_MS: envString(c.env, "FAL_QUEUE_TIMEOUT_MS"),
          ELEVENLABS_API_KEY: envString(c.env, "ELEVENLABS_API_KEY"),
          ELEVENLABS_BASE_URL: envString(c.env, "ELEVENLABS_BASE_URL"),
          SUNO_API_KEY: envString(c.env, "SUNO_API_KEY"),
          SUNO_BASE_URL: envString(c.env, "SUNO_BASE_URL"),
        },
      },
    );

    const music = await storeGeneratedAudio(
      c.env,
      generated,
      `generations/music/${user.organization_id}/${user.id}`,
      {
        userId: user.id,
        organizationId: user.organization_id,
        model: request.model,
        source: "generate-music",
      },
    );

    await reservation.reconcile(cost.totalCost);
    chargeSettled = true;

    const requestId = generated.requestId;
    const status = generated.source === "hosted" ? generated.status : undefined;

    const generation = await generationsService.create({
      organization_id: user.organization_id,
      user_id: user.id,
      type: "music",
      model: request.model,
      provider: definition.provider,
      prompt: request.prompt,
      result: {
        requestId,
        status,
        billingSource: definition.billingSource,
        raw: generated.raw,
      },
      status: "completed",
      storage_url: music.url,
      thumbnail_url: null,
      file_size: music.file_size ? BigInt(music.file_size) : undefined,
      mime_type: music.content_type ?? "audio/mpeg",
      parameters: {
        ...(request.durationSeconds !== undefined
          ? { requestedDurationSeconds: request.durationSeconds }
          : {}),
        ...(durationSeconds ? { durationSeconds } : {}),
        durationControl: definition.durationControl,
        hasLyrics: Boolean(request.lyrics),
        lyricsOptimizer: request.lyricsOptimizer,
        instrumental: request.instrumental,
        referenceUrl: request.referenceUrl,
        outputFormat: request.outputFormat,
      },
      dimensions: {
        ...(durationSeconds ? { duration: durationSeconds } : {}),
      },
      cost: String(cost.totalCost),
      credits: String(cost.totalCost),
      job_id: requestId,
      completed_at: new Date(),
    });

    return c.json({
      success: true,
      id: generation.id,
      requestId,
      status: status ?? "completed",
      music,
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
