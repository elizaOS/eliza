/** Handles authenticated music generation, billing, pending-job reconciliation. */
import { Hono } from "hono";
import { z } from "zod";
import {
  admitFlatGenerativeOperation,
  asGenerativeCacheApiError,
  getGenerativeExecutionContext,
  getGenerativePricingCacheOptions,
  requireGenerativeRouteCaller,
} from "@/api-app/lib/generative-route-auth";
import {
  ApiError,
  failureResponse,
  jsonError,
} from "@/lib/api/cloud-worker-errors";
import {
  collectAudioProviderApiKeys,
  getAudioProvider,
} from "@/lib/providers/audio/registry";
import {
  AudioGenerationPendingError,
  type GeneratedAudio,
  MUSIC_PENDING_SETTLEMENT_MARKER,
} from "@/lib/providers/audio/types";
import { type BillingContext, billFlatUsage } from "@/lib/services/ai-billing";
import { calculateMusicGenerationCostFromCatalog } from "@/lib/services/ai-pricing";
import {
  getSupportedMusicModelDefinition,
  SUPPORTED_MUSIC_MODEL_IDS,
} from "@/lib/services/ai-pricing-definitions";
import { contentSafetyService } from "@/lib/services/content-safety";
import { InsufficientCreditsError } from "@/lib/services/credits";
import { generationsService } from "@/lib/services/generations";
import { persistPendingMusicSettlement } from "@/lib/services/pending-music-settlement";
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

function redactProviderErrorMessage(message: string): string {
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|token|secret|authorization)=([^&\s]+)/gi,
      "$1=[REDACTED]",
    );
}

function providerFailureDetails(options: {
  provider: string;
  model: string;
  billingSource: string;
  error: unknown;
}): Record<string, unknown> {
  const errorRecord =
    typeof options.error === "object" && options.error !== null
      ? (options.error as Record<string, unknown>)
      : {};
  const details: Record<string, unknown> = {
    provider: options.provider,
    model: options.model,
    billingSource: options.billingSource,
  };
  const status = errorRecord.status ?? errorRecord.statusCode;
  if (typeof status === "number" && Number.isFinite(status)) {
    details.upstreamStatus = status;
  }
  if (typeof errorRecord.code === "string" && errorRecord.code.trim()) {
    details.upstreamCode = errorRecord.code.trim().slice(0, 128);
  }
  const message =
    options.error instanceof Error
      ? options.error.message
      : typeof options.error === "string"
        ? options.error
        : "";
  if (message.trim()) {
    details.upstreamMessage = redactProviderErrorMessage(message.trim()).slice(
      0,
      500,
    );
  }
  return details;
}

/** Everything the catch needs to persist a pending settlement (#18436). */
interface PendingSettlementContext {
  organizationId: string;
  userId: string;
  model: string;
  prompt: string;
  provider: string;
  billingSource: string;
  totalCost: number;
  durationSeconds?: number;
  parameters: Record<string, unknown>;
}

app.post("/", async (c) => {
  let admission:
    | Awaited<ReturnType<typeof admitFlatGenerativeOperation>>
    | undefined;
  // Once the charge is SETTLED, a later (non-critical, post-settle) failure must
  // NOT hit the catch's reconcile(0) — which is non-idempotent and would refund
  // the already-correct charge, giving free music. Mirrors generate-image.
  let chargeSettled = false;
  let pendingContext: PendingSettlementContext | null = null;

  try {
    const { user, apiKeyId, admissionSnapshot } =
      await requireGenerativeRouteCaller(c, { rateLimitEndpoint: "strict" });
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

    const durationSeconds =
      definition.durationControl === "supported"
        ? (request.durationSeconds ??
          definition.defaultParameters.durationSeconds)
        : undefined;
    const [, cost] = await Promise.all([
      contentSafetyService.assertSafeForPublicUse({
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
      }),
      calculateMusicGenerationCostFromCatalog({
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
        cache: getGenerativePricingCacheOptions(c),
      }),
    ]);
    const billingContext: BillingContext = {
      organizationId: user.organization_id,
      userId: user.id,
      apiKeyId,
      model: request.model,
      provider: definition.provider,
      billingSource: definition.billingSource,
      requestId: `generate-music:${crypto.randomUUID()}`,
      affiliateCode: c.req.header("X-Affiliate-Code"),
      description: `Music generation: ${request.model}`,
    };

    try {
      admission = await admitFlatGenerativeOperation({
        c,
        context: billingContext,
        apiKeyId,
        cost,
        admissionSnapshot,
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

    const parameters = {
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
    };

    pendingContext = {
      organizationId: user.organization_id,
      userId: user.id,
      model: request.model,
      prompt: request.prompt,
      provider: definition.provider,
      billingSource: definition.billingSource,
      totalCost: cost.totalCost,
      durationSeconds,
      parameters,
    };

    await admission.markProviderDispatched?.();
    let generated: GeneratedAudio;
    try {
      generated = await getAudioProvider(definition.billingSource).generate({
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
        apiKeys: collectAudioProviderApiKeys(c.env),
      });
    } catch (error) {
      // error-policy:J1 the pending path rethrows for the outer settlement
      // handler; every other provider failure is translated into a structured
      // 503 ApiError at this boundary, mirroring generate-video.
      if (error instanceof AudioGenerationPendingError) throw error;
      throw new ApiError(
        503,
        "internal_error",
        "Music provider request failed",
        providerFailureDetails({
          provider: definition.provider,
          model: request.model,
          billingSource: definition.billingSource,
          error,
        }),
      );
    }

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

    const requestId = generated.requestId;
    const status = generated.source === "hosted" ? generated.status : undefined;
    const generationId = crypto.randomUUID();
    let billingApplied = false;
    const persistenceTask = (async () => {
      await billFlatUsage(billingContext, cost, admission?.reservation);
      billingApplied = true;
      chargeSettled = true;
      await generationsService.create({
        id: generationId,
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
        parameters,
        dimensions: {
          ...(durationSeconds ? { duration: durationSeconds } : {}),
        },
        cost: String(cost.totalCost),
        credits: String(cost.totalCost),
        job_id: requestId,
        completed_at: new Date(),
      });
    })().catch(async (error) => {
      if (!billingApplied) await admission?.settleUnknown();
      // error-policy:J7 billing and generation records persist after the audio
      // response; conservative settlement remains observable on failure.
      logger.error("[GenerateMusic] Background persistence failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const executionCtx = getGenerativeExecutionContext(c);
    if (executionCtx) executionCtx.waitUntil(persistenceTask);
    else void persistenceTask;

    return c.json({
      success: true,
      id: generationId,
      requestId,
      status: status ?? "completed",
      music,
      cost,
    });
  } catch (error) {
    // Poll timeout with the upstream job still live (#18436): the render may
    // still complete and bill the platform, so the hold must NOT be refunded.
    // Persist the job for the reconcile sweep, which verifies the upstream
    // terminal state — charging on late success, refunding once on failure.
    if (
      error instanceof AudioGenerationPendingError &&
      admission &&
      !chargeSettled &&
      pendingContext
    ) {
      const pendingAdmission = admission;
      const pending = pendingContext;
      const pendingGenerationId = crypto.randomUUID();
      // Durable generation row is a prerequisite for a pollable 202. A fabricated
      // id that never landed in the DB 404s on /gallery/:id and is invisible to
      // the reconcile sweep (#18719 review).
      try {
        await persistPendingMusicSettlement({
          generationId: pendingGenerationId,
          requestId: error.requestId,
          ...pending,
          settlementMarker: MUSIC_PENDING_SETTLEMENT_MARKER,
          existingReservation:
            pendingAdmission.mode === "synchronous_reservation"
              ? pendingAdmission.reservation
              : undefined,
          releaseDeferredAdmission: () => pendingAdmission.settle(0),
        });
      } catch (persistError) {
        // Hold stays open (upstream may still complete). Do not advertise a
        // pollable generation id. Reservation metadata + requestId remain the
        // stranded-sweep / ops correlation keys.
        logger.error(
          "[GenerateMusic] Failed to persist pending settlement — hold retained, no pollable id",
          {
            requestId: error.requestId,
            generationId: pendingGenerationId,
            error:
              persistError instanceof Error
                ? persistError.message
                : String(persistError),
          },
        );
        return c.json(
          {
            success: false,
            status: "untracked",
            requestId: error.requestId,
            error:
              "Music generation is still running upstream, but tracking could not be persisted. Credits stay reserved. Do not poll a generation id.",
          },
          503,
        );
      }
      logger.warn(
        "[GenerateMusic] Upstream job still pending after poll window — holding credits for reconcile",
        {
          generationId: pendingGenerationId,
          requestId: error.requestId,
          organizationId: pending.organizationId,
          billedCost: pending.totalCost,
        },
      );
      return c.json(
        {
          success: false,
          status: "pending",
          id: pendingGenerationId,
          requestId: error.requestId,
          error:
            "Music generation is still running upstream. Credits stay reserved and settle automatically: charged if the track completes, refunded if it fails. Poll GET /api/v1/gallery/:id until status is completed or failed.",
        },
        202,
      );
    }
    if (admission && !chargeSettled) {
      const release = admission.settle(0);
      const executionCtx = getGenerativeExecutionContext(c);
      const observed = release.catch((reconcileError) => {
        logger.error("[GenerateMusic] Failed to refund reservation", {
          error:
            reconcileError instanceof Error
              ? reconcileError.message
              : String(reconcileError),
        });
      });
      if (executionCtx) executionCtx.waitUntil(observed);
      else await observed;
    }
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
});

app.all("*", (c) =>
  c.json({ success: false, error: "Method not allowed" }, 405),
);

export default app;
