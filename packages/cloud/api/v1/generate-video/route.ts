/** Handles authenticated video generation, billing, and pending-job reconciliation. */
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
  collectVideoProviderApiKeys,
  getVideoProvider,
} from "@/lib/providers/video/registry";
import {
  VIDEO_PENDING_SETTLEMENT_MARKER,
  VideoGenerationPendingError,
} from "@/lib/providers/video/types";
import { type BillingContext, billFlatUsage } from "@/lib/services/ai-billing";
import {
  calculateVideoGenerationCostFromCatalog,
  getDefaultVideoBillingDimensions,
} from "@/lib/services/ai-pricing";
import {
  getSupportedVideoModelDefinition,
  SUPPORTED_VIDEO_MODEL_IDS,
} from "@/lib/services/ai-pricing-definitions";
import { contentSafetyService } from "@/lib/services/content-safety";
import { InsufficientCreditsError } from "@/lib/services/credits";
import { generationsService } from "@/lib/services/generations";
import { persistPendingVideoSettlement } from "@/lib/services/pending-video-settlement";
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

/** Everything the catch needs to persist a pending settlement (#11862). */
interface PendingSettlementContext {
  organizationId: string;
  userId: string;
  model: string;
  prompt: string;
  provider: string;
  billingSource: string;
  totalCost: number;
  durationSeconds: number;
  parameters: Record<string, unknown>;
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

app.post("/", async (c) => {
  let admission:
    | Awaited<ReturnType<typeof admitFlatGenerativeOperation>>
    | undefined;
  // Once the charge is SETTLED, a later (non-critical, post-settle) failure must
  // NOT hit the catch's reconcile(0) — which is non-idempotent and would refund
  // the already-correct charge, giving a free video. Mirrors generate-image.
  let chargeSettled = false;
  let pendingContext: PendingSettlementContext | null = null;

  try {
    const { user, apiKeyId, admissionSnapshot } =
      await requireGenerativeRouteCaller(c, { rateLimitEndpoint: "strict" });
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
    const apiKeys = collectVideoProviderApiKeys(c.env);
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
    const [, cost] = await Promise.all([
      contentSafetyService.assertSafeForPublicUse({
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
      }),
      calculateVideoGenerationCostFromCatalog({
        model: request.model,
        billingSource: definition.billingSource,
        durationSeconds,
        dimensions,
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
      requestId: `generate-video:${crypto.randomUUID()}`,
      affiliateCode: c.req.header("X-Affiliate-Code"),
      description: `Video generation: ${request.model}`,
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

    pendingContext = {
      organizationId: user.organization_id,
      userId: user.id,
      model: request.model,
      prompt: request.prompt,
      provider: definition.provider,
      billingSource: definition.billingSource,
      totalCost: cost.totalCost,
      durationSeconds,
      parameters: {
        referenceUrl: request.referenceUrl,
        durationSeconds,
        resolution: request.resolution,
        audio: request.audio,
        voiceControl: request.voiceControl,
      },
    };

    let generated: Awaited<ReturnType<typeof provider.generate>>;
    try {
      await admission.markProviderDispatched?.();
      generated = await provider.generate({
        ...request,
        // Bill-what-you-deliver: the org is charged for the RESOLVED duration
        // (request.durationSeconds ?? the catalog default), but the raw request
        // spread would forward an undefined durationSeconds when the client omits
        // it — the provider then renders its OWN default (potentially longer),
        // so the platform pays for a longer clip than it billed. Forward the
        // resolved value so the generated duration matches the charge.
        durationSeconds,
        apiKeys,
      });
    } catch (error) {
      if (error instanceof VideoGenerationPendingError) throw error;
      throw new ApiError(
        503,
        "internal_error",
        "Video provider request failed",
        providerFailureDetails({
          provider: definition.provider,
          model: request.model,
          billingSource: definition.billingSource,
          error,
        }),
      );
    }
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
    })().catch(async (error) => {
      if (!billingApplied) await admission?.settleUnknown();
      // error-policy:J7 successful video billing/history persistence runs
      // outside the response; conservative settlement remains observable.
      logger.error("[GenerateVideo] Background persistence failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const executionCtx = getGenerativeExecutionContext(c);
    if (executionCtx) executionCtx.waitUntil(persistenceTask);
    else void persistenceTask;

    return c.json({
      success: true,
      id: generationId,
      requestId: generated.requestId,
      video: generated.video,
      seed: generated.seed,
      timings: generated.timings,
      has_nsfw_concepts: generated.hasNsfwConcepts,
      cost,
    });
  } catch (error) {
    // Poll timeout with the upstream job still live (#11862): the render may
    // still complete and bill the platform, so the hold must NOT be refunded.
    // Persist the job for the reconcile sweep, which verifies the upstream
    // terminal state — charging on late success, refunding once on failure.
    if (
      error instanceof VideoGenerationPendingError &&
      admission &&
      !chargeSettled &&
      pendingContext
    ) {
      const pendingAdmission = admission;
      const pending = pendingContext;
      const pendingGenerationId = crypto.randomUUID();
      const persistPendingSettlement = persistPendingVideoSettlement({
        generationId: pendingGenerationId,
        requestId: error.requestId,
        ...pending,
        settlementMarker: VIDEO_PENDING_SETTLEMENT_MARKER,
        existingReservation:
          pendingAdmission.mode === "synchronous_reservation"
            ? pendingAdmission.reservation
            : undefined,
        releaseDeferredAdmission: () => pendingAdmission.settle(0),
      })
        .then(() => {
          logger.warn(
            "[GenerateVideo] Upstream job still pending after poll window — holding credits for reconcile",
            {
              generationId: pendingGenerationId,
              requestId: error.requestId,
              organizationId: pending.organizationId,
              billedCost: pending.totalCost,
            },
          );
        })
        .catch((persistError) => {
          // error-policy:J7 the upstream job may still bill us, so a failed
          // detached persistence must retain the admitted hold for the sweep.
          logger.error(
            "[GenerateVideo] Failed to persist pending settlement — leaving hold for the reservation sweep",
            {
              requestId: error.requestId,
              error:
                persistError instanceof Error
                  ? persistError.message
                  : String(persistError),
            },
          );
        });
      const executionCtx = getGenerativeExecutionContext(c);
      if (executionCtx) executionCtx.waitUntil(persistPendingSettlement);
      else await persistPendingSettlement;
      return c.json(
        {
          success: false,
          status: "pending",
          id: pendingGenerationId,
          requestId: error.requestId,
          error:
            "Video generation is still running upstream. Credits stay reserved and settle automatically: charged if the video completes, refunded if it fails.",
        },
        202,
      );
    }
    if (admission && !chargeSettled) {
      const release = admission.settle(0);
      const executionCtx = getGenerativeExecutionContext(c);
      const observed = release.catch((reconcileError) => {
        logger.error("[GenerateVideo] Failed to release admission", {
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
