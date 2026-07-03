/**
 * POST /api/v1/generate-sfx — sound-effect generation.
 *
 * Same pipeline as generate-music (validate → safety → price → reserve →
 * provider via the audio registry → store → persist → settle), but a separate
 * route + model catalog: SFX models (ElevenLabs sound-generation, Stable
 * Audio 2.5 on fal) have a different request contract (short clips, prompt
 * influence, no lyrics) and their own pricing family ("sfx").
 */

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
import { calculateSfxGenerationCostFromCatalog } from "@/lib/services/ai-pricing";
import {
  getSupportedSfxModelDefinition,
  SUPPORTED_SFX_MODEL_IDS,
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

const DEFAULT_SFX_MODEL = "elevenlabs/sound_effects_v1";
const MAX_PROMPT_LENGTH = 500;

const sfxRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
  model: z.string().trim().default(DEFAULT_SFX_MODEL),
  durationSeconds: z.coerce.number().min(0.5).max(190).optional(),
  promptInfluence: z.coerce.number().min(0).max(1).optional(),
  seed: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
  outputFormat: z.string().trim().max(64).optional(),
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
  return Boolean(envString(env, "ELEVENLABS_API_KEY"));
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

async function storeGeneratedSfx(
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
  // Post-settle failures must not refund a settled charge (mirrors
  // generate-image / generate-video / generate-music).
  let chargeSettled = false;

  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const request = sfxRequestSchema.parse(await c.req.json());
    const definition = getSupportedSfxModelDefinition(request.model);
    if (!definition) {
      return jsonError(
        c,
        400,
        `Unsupported SFX model: ${request.model}`,
        "validation_error",
        {
          supportedModels: SUPPORTED_SFX_MODEL_IDS,
        },
      );
    }
    if (
      request.durationSeconds !== undefined &&
      request.durationSeconds > definition.defaultParameters.maxDurationSeconds
    ) {
      return jsonError(
        c,
        400,
        `${request.model} supports at most ${definition.defaultParameters.maxDurationSeconds}s per clip`,
        "validation_error",
      );
    }
    if (!providerConfigured(c.env, definition.provider)) {
      return jsonError(
        c,
        503,
        `${definition.provider} SFX generation is not configured`,
        "internal_error",
      );
    }

    await contentSafetyService.assertSafeForPublicUse({
      surface: "media_generation_prompt",
      organizationId: user.organization_id,
      userId: user.id,
      text: [`Sound effect prompt: ${request.prompt}`],
      metadata: {
        type: "sfx",
        model: request.model,
        provider: definition.provider,
      },
    });

    const durationSeconds =
      request.durationSeconds ?? definition.defaultParameters.durationSeconds;
    const cost = await calculateSfxGenerationCostFromCatalog({
      model: request.model,
      provider: definition.provider,
      billingSource: definition.billingSource,
      durationSeconds,
      dimensions: { durationSeconds },
    });

    try {
      reservation = await creditsService.reserve({
        organizationId: user.organization_id,
        userId: user.id,
        amount: cost.totalCost,
        description: `SFX generation: ${request.model}`,
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
        kind: "sfx",
        model: request.model,
        prompt: request.prompt,
        durationSeconds: request.durationSeconds,
        promptInfluence: request.promptInfluence,
        seed: request.seed,
        outputFormat: request.outputFormat,
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
        },
      },
    );

    const audio = await storeGeneratedSfx(
      c.env,
      generated,
      `generations/sfx/${user.organization_id}/${user.id}`,
      {
        userId: user.id,
        organizationId: user.organization_id,
        model: request.model,
        source: "generate-sfx",
      },
    );

    await reservation.reconcile(cost.totalCost);
    chargeSettled = true;

    const requestId = generated.requestId;

    const generation = await generationsService.create({
      organization_id: user.organization_id,
      user_id: user.id,
      type: "sfx",
      model: request.model,
      provider: definition.provider,
      prompt: request.prompt,
      result: {
        requestId,
        billingSource: definition.billingSource,
        raw: generated.raw,
      },
      status: "completed",
      storage_url: audio.url,
      thumbnail_url: null,
      file_size: audio.file_size ? BigInt(audio.file_size) : undefined,
      mime_type: audio.content_type ?? "audio/mpeg",
      parameters: {
        durationSeconds,
        promptInfluence: request.promptInfluence,
        outputFormat: request.outputFormat,
      },
      dimensions: {
        duration: durationSeconds,
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
      audio,
      cost,
    });
  } catch (error) {
    if (reservation && !chargeSettled) {
      await reservation.reconcile(0).catch((reconcileError) => {
        logger.error("[GenerateSfx] Failed to refund reservation", {
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
