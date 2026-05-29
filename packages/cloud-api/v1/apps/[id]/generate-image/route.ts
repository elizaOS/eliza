import { Hono } from "hono";
import { z } from "zod";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getAiProviderConfigurationError } from "@/lib/providers/language-model";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { calculateImageGenerationCostFromCatalog } from "@/lib/services/ai-pricing";
import {
  getSupportedImageModelDefinition,
  SUPPORTED_IMAGE_MODEL_IDS,
} from "@/lib/services/ai-pricing-definitions";
import { appCreditsService } from "@/lib/services/app-credits";
import { appsService } from "@/lib/services/apps";
import { contentSafetyService } from "@/lib/services/content-safety";
import { generationsService } from "@/lib/services/generations";
import { getImageProvider } from "@/lib/providers/image/registry";
import { putPublicObject } from "@/lib/storage/r2-public-object";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const DEFAULT_IMAGE_MODEL = "google/gemini-2.5-flash-image";
const MAX_PROMPT_LENGTH = 4000;
const MAX_IMAGES = 4;

const imageRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
  model: z.string().trim().default(DEFAULT_IMAGE_MODEL),
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

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function imageDimensions(request: ImageRequest): Record<string, string | number> {
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
  if (request.width && request.height) parts.push(`Canvas: ${request.width}x${request.height}.`);
  if (request.stylePreset && request.stylePreset !== "none") {
    parts.push(`Style: ${request.stylePreset}.`);
  }
  return parts.join("\n");
}

function failOpenContentSafety(): boolean {
  return getCloudAwareEnv().CONTENT_SAFETY_FAIL_OPEN !== "false";
}

function isTransientContentSafetyError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number" && status >= 500) return true;
  if (typeof status === "number" && status === 429) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("moderation is unavailable") ||
    message.includes("moderation returned no result") ||
    message.includes("moderation is not configured")
  );
}

async function assertSafeFailOpen(input: Parameters<typeof contentSafetyService.assertSafeForPublicUse>[0]) {
  try {
    return await contentSafetyService.assertSafeForPublicUse(input);
  } catch (error) {
    if (failOpenContentSafety() && isTransientContentSafetyError(error)) {
      logger.warn("[App GenerateImage] Content safety unavailable, allowing due to fail-open", {
        surface: input.surface,
        appId: input.appId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    throw error;
  }
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  try {
    const appId = c.req.param("id") ?? "";
    if (!appId) {
      return jsonError(c, 400, "Missing app id", "validation_error");
    }

    const [appRecord, user] = await Promise.all([
      appsService.getById(appId),
      requireUserOrApiKeyWithOrg(c),
    ]);

    if (!appRecord) {
      return jsonError(c, 404, "App not found", "resource_not_found");
    }

    if (!appRecord.monetization_enabled && appRecord.organization_id !== user.organization_id) {
      return jsonError(c, 403, "Access denied to this app", "access_denied");
    }

    if (!c.env.BLOB) {
      return jsonError(c, 503, "R2 storage is not configured", "internal_error");
    }

    const request = imageRequestSchema.parse(await c.req.json());
    const definition = getSupportedImageModelDefinition(request.model);
    if (!definition) {
      return jsonError(c, 400, `Unsupported image model: ${request.model}`, "validation_error", {
        supportedModels: SUPPORTED_IMAGE_MODEL_IDS,
      });
    }

    const provider = getImageProvider(definition.billingSource);
    const env = getCloudAwareEnv();
    const apiKeys = {
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
      FAL_KEY: env.FAL_KEY,
      FAL_API_KEY: env.FAL_API_KEY,
    };
    if (definition.billingSource === "openrouter" && !apiKeys.OPENROUTER_API_KEY) {
      return jsonError(c, 503, getAiProviderConfigurationError(), "internal_error");
    }
    if (definition.billingSource === "fal" && !apiKeys.FAL_KEY && !apiKeys.FAL_API_KEY) {
      return jsonError(c, 503, getAiProviderConfigurationError(), "internal_error");
    }

    await assertSafeFailOpen({
      surface: "media_generation_prompt",
      organizationId: user.organization_id,
      userId: user.id,
      appId,
      text: request.prompt,
      imageUrls: request.sourceImage ? [request.sourceImage] : undefined,
      allowDataImages: true,
      metadata: { type: "image", model: request.model, billingSource: definition.billingSource },
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
      return c.json(
        {
          success: false,
          error: deduction.message || "Insufficient app credits",
          code: "insufficient_app_credits",
          required: deduction.totalCost,
          balance: deduction.newBalance,
        },
        402,
      );
    }

    let images: GeneratedImage[];
    try {
      images = [];
      for (let index = 0; index < request.numImages; index += 1) {
        const generated = await provider.generate({
          model: request.model,
          prompt: buildImagePrompt(request),
          sourceImage: request.sourceImage,
          aspectRatio: request.aspectRatio,
          size: request.width && request.height ? `${request.width}x${request.height}` : undefined,
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

        try {
          await assertSafeFailOpen({
            surface: "media_generation_output",
            organizationId: user.organization_id,
            userId: user.id,
            appId,
            imageUrls: [url],
            metadata: { type: "image", model: request.model, billingSource: definition.billingSource },
          });
        } catch (safetyError) {
          await c.env.BLOB.delete(storedKey).catch((deleteError) => {
            logger.error("[App GenerateImage] Failed to delete blocked image output", {
              key: storedKey,
              error: deleteError instanceof Error ? deleteError.message : String(deleteError),
            });
          });
          throw safetyError;
        }

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
      await appCreditsService
        .reconcileCredits({
          appId,
          userId: user.id,
          estimatedBaseCost: cost.totalCost,
          actualBaseCost: 0,
          description: "Refund due to image generation failure",
          metadata: { error: true, model: request.model, endpoint: "apps.generate-image" },
          app: appRecord,
        })
        .catch((refundError) => {
          logger.error("[App GenerateImage] Refund failed", {
            appId,
            userId: user.id,
            error: refundError instanceof Error ? refundError.message : String(refundError),
          });
        });
      throw generationError;
    }

    await Promise.all(
      images.map((image) =>
        generationsService
          .create({
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
          })
          .catch((recordError) => {
            logger.warn("[App GenerateImage] Failed to record generation", {
              appId,
              error: recordError instanceof Error ? recordError.message : String(recordError),
            });
          }),
      ),
    );

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

    return c.json({
      success: true,
      appId,
      model: request.model,
      images: images.map(({ image, url, text }) => ({ image, url, text })),
      cost,
      charge: {
        status: "charged",
        currency: "USD",
        baseCost: deduction.baseCost,
        creatorMarkup: deduction.creatorMarkup,
        totalCost: deduction.totalCost,
        creatorEarnings: deduction.creatorEarnings,
        balance: deduction.newBalance,
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.all("*", (c) => c.json({ success: false, error: "Method not allowed" }, 405));

export default app;
