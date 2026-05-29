import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { nextStyleParams } from "@/lib/api/hono-next-style-params";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  addCorsHeaders,
  createPreflightResponse,
} from "@/lib/middleware/cors-apps";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getAiProviderConfigurationError } from "@/lib/providers/language-model";
import { generateOpenRouterImage } from "@/lib/providers/openrouter-image-generation";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { calculateImageGenerationCostFromCatalog } from "@/lib/services/ai-pricing";
import {
  getSupportedImageModelDefinition,
  SUPPORTED_IMAGE_MODEL_IDS,
} from "@/lib/services/ai-pricing-definitions";
import { appCreditsService } from "@/lib/services/app-credits";
import { appsService } from "@/lib/services/apps";
import { generationsService } from "@/lib/services/generations";
import { putPublicObject } from "@/lib/storage/r2-public-object";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

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

interface RouteContext {
  params: Promise<{ id: string }>;
}

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
  return await generateOpenRouterImage({
    apiKey: getCloudAwareEnv().OPENROUTER_API_KEY,
    model: request.model,
    prompt: buildImagePrompt(request),
    sourceImage: request.sourceImage,
    aspectRatio: request.aspectRatio,
  });
}

async function __next_OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  return createPreflightResponse(origin, ["POST", "OPTIONS"]);
}

async function handlePOST(
  c: AppContext,
  request: Request,
  context: RouteContext,
  env: AppEnv["Bindings"],
): Promise<Response> {
  const origin = request.headers.get("origin");
  const withCors = (response: Response): Response =>
    addCorsHeaders(response, origin, ["POST", "OPTIONS"]);

  const { id: appId } = await context.params;
  let deducted = false;
  let reservedBaseCost = 0;
  let userId: string | null = null;
  let appRecord: Awaited<ReturnType<typeof appsService.getById>> | null = null;

  try {
    if (!env.BLOB) {
      return withCors(
        Response.json(
          {
            success: false,
            error: {
              message: "R2 storage is not configured",
              code: "internal_error",
            },
          },
          { status: 503 },
        ),
      );
    }

    const [app, user, rawBody] = await Promise.all([
      appsService.getById(appId),
      requireUserOrApiKeyWithOrg(c),
      request.json(),
    ]);
    appRecord = app;

    if (!app) {
      return withCors(
        Response.json(
          {
            success: false,
            error: { message: "App not found", code: "app_not_found" },
          },
          { status: 404 },
        ),
      );
    }

    userId = user.id;

    if (
      !app.monetization_enabled &&
      app.organization_id !== user.organization_id
    ) {
      return withCors(
        Response.json(
          {
            success: false,
            error: {
              message: "Access denied to this app",
              code: "access_denied",
            },
          },
          { status: 403 },
        ),
      );
    }

    const parsed = imageRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return withCors(
        Response.json(
          {
            success: false,
            error: {
              message: "Invalid request data",
              code: "validation_error",
              details: parsed.error.format(),
            },
          },
          { status: 400 },
        ),
      );
    }
    const imageRequest = parsed.data;

    const definition = getSupportedImageModelDefinition(imageRequest.model);
    if (!definition) {
      return withCors(
        Response.json(
          {
            success: false,
            error: {
              message: `Unsupported image model: ${imageRequest.model}`,
              code: "validation_error",
              supportedModels: SUPPORTED_IMAGE_MODEL_IDS,
            },
          },
          { status: 400 },
        ),
      );
    }

    if (!getCloudAwareEnv().OPENROUTER_API_KEY) {
      return withCors(
        Response.json(
          {
            success: false,
            error: {
              message: getAiProviderConfigurationError(),
              code: "internal_error",
            },
          },
          { status: 503 },
        ),
      );
    }

    const cost = await calculateImageGenerationCostFromCatalog({
      model: imageRequest.model,
      provider: definition.provider,
      billingSource: definition.billingSource,
      imageCount: imageRequest.numImages,
      dimensions: {
        ...definition.defaultDimensions,
        ...imageDimensions(imageRequest),
      },
    });
    reservedBaseCost = cost.totalCost;

    const deductionResult = await appCreditsService.deductCredits({
      appId,
      userId: user.id,
      baseCost: reservedBaseCost,
      description: `Image generation: ${imageRequest.model} x${imageRequest.numImages}`,
      metadata: {
        model: imageRequest.model,
        provider: definition.provider,
        billingSource: definition.billingSource,
        imageCount: imageRequest.numImages,
        dimensions: {
          ...definition.defaultDimensions,
          ...imageDimensions(imageRequest),
        },
        endpoint: "apps.generate-image",
      },
      app,
    });

    if (!deductionResult.success) {
      return withCors(
        Response.json(
          {
            success: false,
            error: {
              message: deductionResult.message ?? "Insufficient cloud credits",
              type: "insufficient_quota",
              code: "insufficient_app_credits",
              required: deductionResult.totalCost,
              balance: deductionResult.newBalance,
            },
          },
          { status: 402 },
        ),
      );
    }
    deducted = true;

    const images: GeneratedImage[] = [];
    for (let index = 0; index < imageRequest.numImages; index += 1) {
      const generated = await generateOneImage(imageRequest);
      const ext = extensionForMimeType(generated.mimeType);
      const key = `generations/images/apps/${appId}/${user.organization_id}/${user.id}/${crypto.randomUUID()}.${ext}`;
      const { url, key: storedKey } = await putPublicObject(env, {
        key,
        body: generated.bytes,
        contentType: generated.mimeType,
        customMetadata: {
          appId,
          userId: user.id,
          organizationId: user.organization_id,
          model: imageRequest.model,
          source: "apps.generate-image",
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

    await appCreditsService.reconcileCredits({
      appId,
      userId: user.id,
      estimatedBaseCost: reservedBaseCost,
      actualBaseCost: cost.totalCost,
      description: `Image generation reconciliation: ${imageRequest.model}`,
      metadata: {
        model: imageRequest.model,
        provider: definition.provider,
        imageCount: imageRequest.numImages,
        endpoint: "apps.generate-image",
      },
      app,
    });

    await Promise.all(
      images.map((image) =>
        generationsService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          type: "image",
          model: imageRequest.model,
          provider: definition.provider,
          prompt: imageRequest.prompt,
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
            appId,
            numImages: imageRequest.numImages,
            aspectRatio: imageRequest.aspectRatio,
            stylePreset: imageRequest.stylePreset,
            width: imageRequest.width,
            height: imageRequest.height,
            hasSourceImage: Boolean(imageRequest.sourceImage),
          },
          dimensions: {
            width: imageRequest.width,
            height: imageRequest.height,
          },
          cost: String(cost.totalCost),
          credits: String(deductionResult.totalCost),
          completed_at: new Date(),
        }),
      ),
    );

    logger.info("[App GenerateImage] Request completed", {
      appId,
      userId: user.id,
      model: imageRequest.model,
      baseCost: deductionResult.baseCost,
      totalCost: deductionResult.totalCost,
      creatorEarnings: deductionResult.creatorEarnings,
      imageCount: images.length,
    });

    return withCors(
      Response.json({
        success: true,
        appId,
        model: imageRequest.model,
        images: images.map(({ image, url, text }) => ({ image, url, text })),
        cost,
        charge: {
          status: "charged",
          currency: "USD",
          baseCost: deductionResult.baseCost,
          creatorMarkup: deductionResult.creatorMarkup,
          totalCost: deductionResult.totalCost,
          creatorEarnings: deductionResult.creatorEarnings,
          balance: deductionResult.newBalance,
        },
      }),
    );
  } catch (error) {
    logger.error("[App GenerateImage] Error:", error);
    if (deducted && userId) {
      await appCreditsService
        .reconcileCredits({
          appId,
          userId,
          estimatedBaseCost: reservedBaseCost,
          actualBaseCost: 0,
          description: "Refund due to app image generation error",
          metadata: { error: true, endpoint: "apps.generate-image" },
          ...(appRecord ? { app: appRecord } : {}),
        })
        .catch((reconcileError) => {
          logger.error(
            "[App GenerateImage] Failed to refund reserved credits",
            {
              appId,
              userId,
              error:
                reconcileError instanceof Error
                  ? reconcileError.message
                  : String(reconcileError),
            },
          );
        });
    }

    return withCors(failureResponse(c, error));
  }
}

const ROUTE_PARAM_SPEC = [{ name: "id", splat: false }] as const;
const honoRouter = new Hono<AppEnv>();

honoRouter.options("/", async (c) => {
  try {
    return await __next_OPTIONS(c.req.raw);
  } catch (error) {
    return failureResponse(c, error);
  }
});

honoRouter.post("/", rateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    return await handlePOST(
      c,
      c.req.raw,
      nextStyleParams(c, ROUTE_PARAM_SPEC),
      c.env,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default honoRouter;
