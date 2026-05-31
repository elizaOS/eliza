import { Hono } from "hono";
import { z } from "zod";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
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
  getSupportedImageModelDefinition,
  SUPPORTED_IMAGE_MODEL_IDS,
} from "@/lib/services/ai-pricing-definitions";
import { contentSafetyService } from "@/lib/services/content-safety";
import {
  creditsService,
  InsufficientCreditsError,
} from "@/lib/services/credits";
import { generationsService } from "@/lib/services/generations";
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

async function deleteStoredImages(
  env: AppEnv["Bindings"],
  images: Pick<GeneratedImage, "key">[],
): Promise<void> {
  await Promise.all(
    images.map((image) =>
      env.BLOB.delete(image.key).catch((deleteError) => {
        logger.error("[GenerateImage] Failed to delete generated image", {
          key: image.key,
          error:
            deleteError instanceof Error
              ? deleteError.message
              : String(deleteError),
        });
      }),
    ),
  );
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

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

async function generateOneImage(request: ImageRequest): Promise<{
  dataUrl: string;
  bytes: Uint8Array;
  mimeType: string;
  text: string;
}> {
  const definition = getSupportedImageModelDefinition(request.model);
  if (!definition) {
    throw new Error(`Unsupported image model: ${request.model}`);
  }
  const env = getCloudAwareEnv();
  return await getImageProvider(definition.billingSource).generate({
    model: request.model,
    prompt: buildImagePrompt(request),
    sourceImage: request.sourceImage,
    aspectRatio: request.aspectRatio,
    size:
      request.width && request.height
        ? `${request.width}x${request.height}`
        : undefined,
    apiKeys: {
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
      FAL_KEY: env.FAL_KEY,
      FAL_API_KEY: env.FAL_API_KEY,
    },
  });
}

app.post("/", async (c) => {
  let reservation: Awaited<ReturnType<typeof creditsService.reserve>> | null =
    null;
  let chargeSettled = false;
  const images: GeneratedImage[] = [];

  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    if (!c.env.BLOB) {
      return jsonError(
        c,
        503,
        "R2 storage is not configured",
        "internal_error",
      );
    }

    const request = imageRequestSchema.parse(await c.req.json());
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
    const env = getCloudAwareEnv();
    if (definition.billingSource === "openrouter" && !env.OPENROUTER_API_KEY) {
      return jsonError(
        c,
        503,
        getAiProviderConfigurationError(),
        "internal_error",
      );
    }
    if (
      definition.billingSource === "fal" &&
      !env.FAL_KEY &&
      !env.FAL_API_KEY
    ) {
      return jsonError(
        c,
        503,
        getAiProviderConfigurationError(),
        "internal_error",
      );
    }

    await contentSafetyService.assertSafeForPublicUse({
      surface: "media_generation_prompt",
      organizationId: user.organization_id,
      userId: user.id,
      text: request.prompt,
      imageUrls: request.sourceImage ? [request.sourceImage] : undefined,
      allowDataImages: true,
      metadata: { type: "image", model: request.model },
    });

    const cost = await calculateImageGenerationCostFromCatalog({
      model: request.model,
      provider: definition.provider,
      billingSource: definition.billingSource,
      imageCount: request.numImages,
      dimensions: {
        ...definition.defaultDimensions,
        ...imageDimensions(request),
      },
    });

    try {
      reservation = await creditsService.reserve({
        organizationId: user.organization_id,
        userId: user.id,
        amount: cost.totalCost,
        description: `Image generation: ${request.model} x${request.numImages}`,
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

    for (let index = 0; index < request.numImages; index += 1) {
      const generated = await generateOneImage(request);
      const ext = extensionForMimeType(generated.mimeType);
      const key = `generations/images/${user.organization_id}/${user.id}/${crypto.randomUUID()}.${ext}`;
      const { url, key: storedKey } = await putPublicObject(c.env, {
        key,
        body: generated.bytes,
        contentType: generated.mimeType,
        customMetadata: {
          userId: user.id,
          organizationId: user.organization_id,
          model: request.model,
          source: "generate-image",
        },
      });

      try {
        await contentSafetyService.assertSafeForPublicUse({
          surface: "media_generation_output",
          organizationId: user.organization_id,
          userId: user.id,
          imageUrls: [url],
          metadata: { type: "image", model: request.model },
        });
      } catch (error) {
        await c.env.BLOB.delete(storedKey).catch((deleteError) => {
          logger.error(
            "[GenerateImage] Failed to delete blocked image output",
            {
              key: storedKey,
              error:
                deleteError instanceof Error
                  ? deleteError.message
                  : String(deleteError),
            },
          );
        });
        throw error;
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

    await reservation.reconcile(cost.totalCost);
    chargeSettled = true;

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
            },
            dimensions: {
              width: request.width,
              height: request.height,
            },
            cost: String(cost.totalCost),
            credits: String(cost.totalCost),
            completed_at: new Date(),
          })
          .catch((recordError) => {
            logger.warn("[GenerateImage] Failed to record generation", {
              error:
                recordError instanceof Error
                  ? recordError.message
                  : String(recordError),
            });
          }),
      ),
    );

    return c.json({
      success: true,
      model: request.model,
      images: images.map(({ image, url, text }) => ({ image, url, text })),
      cost,
    });
  } catch (error) {
    if (!chargeSettled && images.length > 0) {
      await deleteStoredImages(c.env, images);
    }
    if (reservation && !chargeSettled) {
      await reservation.reconcile(0).catch((reconcileError) => {
        logger.error("[GenerateImage] Failed to refund reservation", {
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
