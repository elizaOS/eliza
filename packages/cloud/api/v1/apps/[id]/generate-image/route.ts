// Handles v1 cloud API v1 apps id generate image route traffic with route-local auth expectations.
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbRead, dbWrite } from "@/db/client";
import { appImageGenerationIdempotency } from "@/db/schemas/app-image-generation-idempotency";
import { jsonError } from "@/lib/api/cloud-worker-errors";
import { isAppKeyOutOfScope } from "@/lib/auth/app-key-scope";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getImageProvider } from "@/lib/providers/image/registry";
import { getAiProviderConfigurationError } from "@/lib/providers/language-model";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { calculateImageGenerationCostFromCatalog } from "@/lib/services/ai-pricing";
import {
  DEFAULT_IMAGE_MODEL_ID,
  getSupportedImageModelDefinition,
  SUPPORTED_IMAGE_MODEL_IDS,
} from "@/lib/services/ai-pricing-definitions";
import { appCreditsService } from "@/lib/services/app-credits";
import { appsService } from "@/lib/services/apps";
import { contentSafetyService } from "@/lib/services/content-safety";
import { generationsService } from "@/lib/services/generations";
import { putPublicObject } from "@/lib/storage/r2-public-object";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const MAX_PROMPT_LENGTH = 4000;
const MAX_IMAGES = 4;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const imageRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
  model: z.string().trim().default(DEFAULT_IMAGE_MODEL_ID),
  numImages: z.coerce.number().int().min(1).max(MAX_IMAGES).default(1),
  aspectRatio: z.string().trim().max(16).optional(),
  stylePreset: z.string().trim().max(64).optional(),
  width: z.coerce.number().int().min(128).max(4096).optional(),
  height: z.coerce.number().int().min(128).max(4096).optional(),
  sourceImage: z
    .string()
    .trim()
    .min(1)
    .max(15 * 1024 * 1024)
    .optional(),
});

type ImageRequest = z.infer<typeof imageRequestSchema>;

interface GeneratedImage {
  image: string;
  url: string;
  key: string;
  text: string;
  mimeType: string;
  sizeBytes: number;
}

type ImageGenerationResponse = {
  success: true;
  appId: string;
  model: string;
  images: Array<{ image: string; url: string; text: string }>;
  cost: Awaited<ReturnType<typeof calculateImageGenerationCostFromCatalog>>;
  charge: Record<string, unknown>;
};

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function imageDimensions(
  request: ImageRequest,
): Record<string, string | number> {
  const dimensions: Record<string, string | number> = {};
  if (request.width && request.height) {
    dimensions.size = `${request.width}x${request.height}`;
  } else if (request.aspectRatio) {
    dimensions.aspectRatio = request.aspectRatio;
  }
  if (request.stylePreset && request.stylePreset !== "none") {
    dimensions.stylePreset = request.stylePreset;
  }
  return dimensions;
}

function buildImagePrompt(request: ImageRequest): string {
  const parts = [request.prompt];
  if (request.aspectRatio) parts.push(`Aspect ratio: ${request.aspectRatio}.`);
  if (request.width && request.height)
    parts.push(`Canvas: ${request.width}x${request.height}.`);
  if (request.stylePreset && request.stylePreset !== "none") {
    parts.push(`Style: ${request.stylePreset}.`);
  }
  return parts.join("\n");
}

function failOpenContentSafety(): boolean {
  const env = getCloudAwareEnv();
  const explicitFailOpen = env.CONTENT_SAFETY_FAIL_OPEN === "true";
  const runtimeEnv = String(
    env.NODE_ENV ?? env.ENVIRONMENT ?? env.APP_ENV ?? "",
  ).toLowerCase();
  const internalContext =
    env.CONTENT_SAFETY_INTERNAL_FAIL_OPEN === "true" ||
    runtimeEnv === "development" ||
    runtimeEnv === "test" ||
    runtimeEnv === "local";
  return explicitFailOpen && internalContext;
}

function isTransientContentSafetyError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number" && status >= 500) return true;
  if (typeof status === "number" && status === 429) return true;
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return (
    message.includes("moderation is unavailable") ||
    message.includes("moderation returned no result") ||
    message.includes("moderation is not configured")
  );
}

async function assertSafeFailOpen(
  input: Parameters<typeof contentSafetyService.assertSafeForPublicUse>[0],
) {
  try {
    return await contentSafetyService.assertSafeForPublicUse(input);
  } catch (error) {
    if (failOpenContentSafety() && isTransientContentSafetyError(error)) {
      logger.warn(
        "[App GenerateImage] Content safety unavailable, allowing due to fail-open",
        {
          surface: input.surface,
          appId: input.appId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return null;
    }
    throw error;
  }
}

function sanitizeErrorCode(error: unknown): {
  code: string;
  status: 400 | 402 | 403 | 404 | 409 | 422 | 500 | 503;
} {
  if (error instanceof z.ZodError)
    return { code: "validation_error", status: 400 };
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  if (
    message.includes("content") ||
    message.includes("moderation") ||
    message.includes("safety")
  ) {
    return { code: "content_safety_blocked", status: 422 };
  }
  if (message.includes("not configured") || message.includes("api key")) {
    return { code: "provider_unavailable", status: 503 };
  }
  if (message.includes("unsupported image model"))
    return { code: "validation_error", status: 400 };
  return { code: "image_generation_failed", status: 500 };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeIdempotencyHeader(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 200);
}

async function buildRequestHash(request: ImageRequest): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      prompt: request.prompt,
      model: request.model,
      numImages: request.numImages,
      aspectRatio: request.aspectRatio,
      stylePreset: request.stylePreset,
      width: request.width,
      height: request.height,
      sourceImage: request.sourceImage,
    }),
  );
}

async function deleteStoredImages(
  env: AppEnv["Bindings"],
  keys: string[],
  context: Record<string, unknown>,
) {
  await Promise.all(
    [...new Set(keys)].map((key) =>
      env.BLOB?.delete(key).catch((deleteError) => {
        logger.error(
          "[App GenerateImage] Failed to delete stored image after failure",
          {
            ...context,
            key,
            error:
              deleteError instanceof Error
                ? deleteError.message
                : String(deleteError),
          },
        );
      }),
    ),
  );
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  const requestId = crypto.randomUUID();
  let idempotencyKey: string | undefined;
  try {
    const appId = c.req.param("id") ?? "";
    if (!appId) return jsonError(c, 400, "Missing app id", "validation_error");

    const [appRecord, user] = await Promise.all([
      appsService.getById(appId),
      requireUserOrApiKeyWithOrg(c),
    ]);

    if (!appRecord)
      return jsonError(c, 404, "App not found", "resource_not_found");

    if (
      !appRecord.monetization_enabled &&
      appRecord.organization_id !== user.organization_id
    ) {
      return jsonError(c, 403, "Access denied to this app", "access_denied");
    }
    // An app-scoped API key may only act on its own app, never a sibling (#10852).
    if (await isAppKeyOutOfScope(c.get("apiKeyId"), appId)) {
      return jsonError(c, 403, "Access denied to this app", "access_denied");
    }

    if (!c.env.BLOB)
      return jsonError(
        c,
        503,
        "R2 storage is not configured",
        "internal_error",
      );

    const request = imageRequestSchema.parse(await c.req.json());
    const requestHash = await buildRequestHash(request);
    const suppliedIdempotencyKey = normalizeIdempotencyHeader(
      c.req.header("Idempotency-Key") ?? c.req.header("X-Idempotency-Key"),
    );
    idempotencyKey = suppliedIdempotencyKey
      ? `app-image:${appId}:${user.id}:${suppliedIdempotencyKey}`
      : `app-image:${appId}:${user.id}:${requestHash}`;

    const [claim] = await dbWrite
      .insert(appImageGenerationIdempotency)
      .values({
        key: idempotencyKey,
        app_id: appId,
        user_id: user.id,
        request_hash: requestHash,
        status: "processing",
        expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      })
      .onConflictDoNothing({ target: appImageGenerationIdempotency.key })
      .returning({ id: appImageGenerationIdempotency.id });

    if (!claim) {
      const [existing] = await dbRead
        .select()
        .from(appImageGenerationIdempotency)
        .where(eq(appImageGenerationIdempotency.key, idempotencyKey))
        .limit(1);
      if (!existing || existing.expires_at < new Date()) {
        await dbWrite
          .delete(appImageGenerationIdempotency)
          .where(eq(appImageGenerationIdempotency.key, idempotencyKey));
        return c.json(
          {
            success: false,
            error: "Retry request",
            code: "idempotency_retry",
            requestId,
          },
          409,
        );
      }
      if (existing.request_hash !== requestHash) {
        return c.json(
          {
            success: false,
            error: "Idempotency key reused with a different request",
            code: "idempotency_key_conflict",
            requestId,
          },
          409,
        );
      }
      if (existing.status === "completed" && existing.response_body) {
        return c.json(existing.response_body as ImageGenerationResponse, 200);
      }
      return c.json(
        {
          success: false,
          error: "Request is already processing",
          code: "idempotency_in_progress",
          requestId,
        },
        409,
      );
    }

    const definition = getSupportedImageModelDefinition(request.model);
    if (!definition) {
      return jsonError(
        c,
        400,
        `Unsupported image model: ${request.model}`,
        "validation_error",
        {
          supportedModels: SUPPORTED_IMAGE_MODEL_IDS,
        },
      );
    }

    const provider = getImageProvider(definition.billingSource);
    const env = getCloudAwareEnv();
    const apiKeys = {
      ATLASCLOUD_API_KEY: env.ATLASCLOUD_API_KEY,
      ATLASCLOUD_BASE_URL: env.ATLASCLOUD_BASE_URL,
      FAL_KEY: env.FAL_KEY,
      FAL_API_KEY: env.FAL_API_KEY,
    };
    if (
      definition.billingSource === "atlascloud" &&
      !apiKeys.ATLASCLOUD_API_KEY
    ) {
      return jsonError(
        c,
        503,
        getAiProviderConfigurationError(),
        "internal_error",
      );
    }
    if (
      definition.billingSource === "fal" &&
      !apiKeys.FAL_KEY &&
      !apiKeys.FAL_API_KEY
    ) {
      return jsonError(
        c,
        503,
        getAiProviderConfigurationError(),
        "internal_error",
      );
    }

    await assertSafeFailOpen({
      surface: "media_generation_prompt",
      organizationId: user.organization_id,
      userId: user.id,
      appId,
      text: request.prompt,
      imageUrls: request.sourceImage ? [request.sourceImage] : undefined,
      allowDataImages: true,
      metadata: {
        type: "image",
        model: request.model,
        billingSource: definition.billingSource,
      },
    });

    const dimensions = {
      ...definition.defaultDimensions,
      ...imageDimensions(request),
    };
    const cost = await calculateImageGenerationCostFromCatalog({
      model: request.model,
      provider: definition.provider,
      billingSource: definition.billingSource,
      imageCount: request.numImages,
      dimensions,
    });

    const deduction = await appCreditsService.deductCredits({
      appId,
      userId: user.id,
      baseCost: cost.totalCost,
      description: `Image generation: ${request.model} x${request.numImages}`,
      metadata: {
        model: request.model,
        provider: definition.provider,
        billingSource: definition.billingSource,
        numImages: request.numImages,
        dimensions,
        endpoint: "apps.generate-image",
      },
      app: appRecord,
    });

    if (!deduction.success) {
      await dbWrite
        .delete(appImageGenerationIdempotency)
        .where(eq(appImageGenerationIdempotency.key, idempotencyKey));
      return c.json(
        {
          success: false,
          error: "Insufficient cloud credits",
          code: "insufficient_credits",
          required: deduction.totalCost,
          balance: deduction.newBalance,
        },
        402,
      );
    }

    await dbWrite
      .update(appImageGenerationIdempotency)
      .set({
        charge_id: deduction.transactionId ?? null,
        charge: {
          status: "charged",
          transactionId: deduction.transactionId,
          baseCost: deduction.baseCost,
          creatorMarkup: deduction.creatorMarkup,
          totalCost: deduction.totalCost,
          creatorEarnings: deduction.creatorEarnings,
          balance: deduction.newBalance,
        },
        updated_at: new Date(),
      })
      .where(eq(appImageGenerationIdempotency.key, idempotencyKey))
      .catch((stateError) => {
        logger.error(
          "[App GenerateImage] Failed to persist idempotent charge state",
          {
            appId,
            userId: user.id,
            requestId,
            error:
              stateError instanceof Error
                ? stateError.message
                : String(stateError),
          },
        );
      });

    let images: GeneratedImage[];
    const storedKeys: string[] = [];
    try {
      images = [];
      for (let index = 0; index < request.numImages; index += 1) {
        const generated = await provider.generate({
          model: request.model,
          prompt: buildImagePrompt(request),
          sourceImage: request.sourceImage,
          aspectRatio: request.aspectRatio,
          size:
            request.width && request.height
              ? `${request.width}x${request.height}`
              : undefined,
          apiKeys,
        });
        const ext = extensionForMimeType(generated.mimeType);
        const key = `generations/images/${appRecord.organization_id}/apps/${appId}/${crypto.randomUUID()}.${ext}`;
        const { url, key: storedKey } = await putPublicObject(c.env, {
          key,
          body: generated.bytes,
          contentType: generated.mimeType,
          customMetadata: {
            userId: user.id,
            organizationId: user.organization_id,
            appId,
            model: request.model,
            billingSource: definition.billingSource,
            source: "app-generate-image",
          },
        });
        storedKeys.push(storedKey);

        await assertSafeFailOpen({
          surface: "media_generation_output",
          organizationId: user.organization_id,
          userId: user.id,
          appId,
          imageUrls: [url],
          metadata: {
            type: "image",
            model: request.model,
            billingSource: definition.billingSource,
          },
        });

        images.push({
          image: generated.dataUrl,
          url,
          key: storedKey,
          text: generated.text,
          mimeType: generated.mimeType,
          sizeBytes: generated.bytes.byteLength,
        });
      }
    } catch (generationError) {
      await deleteStoredImages(c.env, storedKeys, {
        appId,
        userId: user.id,
        requestId,
      });
      await appCreditsService
        .reconcileCredits({
          appId,
          userId: user.id,
          estimatedBaseCost: cost.totalCost,
          actualBaseCost: 0,
          description: "Refund due to image generation failure",
          metadata: {
            error: true,
            model: request.model,
            endpoint: "apps.generate-image",
          },
          app: appRecord,
        })
        .catch((refundError) => {
          logger.error("[App GenerateImage] Refund failed", {
            appId,
            userId: user.id,
            error:
              refundError instanceof Error
                ? refundError.message
                : String(refundError),
          });
        });
      await dbWrite
        .delete(appImageGenerationIdempotency)
        .where(eq(appImageGenerationIdempotency.key, idempotencyKey));
      throw generationError;
    }

    const generationIds = (
      await Promise.all(
        images.map(async (image) => {
          try {
            const generation = await generationsService.create({
              organization_id: user.organization_id,
              user_id: user.id,
              type: "image",
              model: request.model,
              provider: definition.provider,
              prompt: request.prompt,
              result: {
                text: image.text,
                r2Key: image.key,
                billingSource: definition.billingSource,
                appId,
              },
              status: "completed",
              storage_url: image.url,
              thumbnail_url: image.url,
              file_size: BigInt(image.sizeBytes),
              mime_type: image.mimeType,
              parameters: {
                numImages: request.numImages,
                aspectRatio: request.aspectRatio,
                stylePreset: request.stylePreset,
                width: request.width,
                height: request.height,
                hasSourceImage: Boolean(request.sourceImage),
                appId,
              },
              dimensions: { width: request.width, height: request.height },
              cost: String(cost.totalCost),
              credits: String(deduction.totalCost),
              completed_at: new Date(),
            });
            return generation.id;
          } catch (recordError) {
            logger.warn("[App GenerateImage] Failed to record generation", {
              appId,
              error:
                recordError instanceof Error
                  ? recordError.message
                  : String(recordError),
            });
            return null;
          }
        }),
      )
    ).filter((id): id is string => Boolean(id));

    logger.info("[App GenerateImage] Completed", {
      appId,
      userId: user.id,
      model: request.model,
      billingSource: definition.billingSource,
      numImages: request.numImages,
      baseCost: deduction.baseCost,
      creatorMarkup: deduction.creatorMarkup,
      totalCost: deduction.totalCost,
      creatorEarnings: deduction.creatorEarnings,
      newBalance: deduction.newBalance,
      monetizationEnabled: appRecord.monetization_enabled,
    });

    const responseBody: ImageGenerationResponse = {
      success: true,
      appId,
      model: request.model,
      images: images.map(({ image, url, text }) => ({ image, url, text })),
      cost,
      charge: {
        status: "charged",
        currency: "USD",
        transactionId: deduction.transactionId,
        baseCost: deduction.baseCost,
        creatorMarkup: deduction.creatorMarkup,
        totalCost: deduction.totalCost,
        creatorEarnings: deduction.creatorEarnings,
        balance: deduction.newBalance,
      },
    };

    await dbWrite
      .update(appImageGenerationIdempotency)
      .set({
        status: "completed",
        response_body: responseBody,
        provider_result: {
          images: images.map(({ url, key, mimeType, sizeBytes }) => ({
            url,
            key,
            mimeType,
            sizeBytes,
          })),
        },
        generation_ids: generationIds,
        updated_at: new Date(),
      })
      .where(eq(appImageGenerationIdempotency.key, idempotencyKey))
      .catch((stateError) => {
        logger.error(
          "[App GenerateImage] Failed to persist idempotent completion state",
          {
            appId,
            userId: user.id,
            requestId,
            error:
              stateError instanceof Error
                ? stateError.message
                : String(stateError),
          },
        );
      });

    return c.json(responseBody);
  } catch (error) {
    if (idempotencyKey) {
      await dbWrite
        .delete(appImageGenerationIdempotency)
        .where(eq(appImageGenerationIdempotency.key, idempotencyKey))
        .catch((stateError) => {
          logger.error(
            "[App GenerateImage] Failed to release idempotency state",
            {
              requestId,
              error:
                stateError instanceof Error
                  ? stateError.message
                  : String(stateError),
            },
          );
        });
    }
    const sanitized = sanitizeErrorCode(error);
    logger.error("[App GenerateImage] Request failed", {
      requestId,
      code: sanitized.code,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return c.json(
      {
        success: false,
        error: "Image generation request failed",
        code: sanitized.code,
        requestId,
      },
      sanitized.status,
    );
  }
});

app.all("*", (c) =>
  c.json({ success: false, error: "Method not allowed" }, 405),
);

export default app;
