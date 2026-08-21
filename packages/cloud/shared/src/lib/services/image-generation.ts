/**
 * Executes the canonical Cloud image transaction for HTTP and agent callers.
 * Authentication remains at each transport boundary; this service owns the
 * shared safety, pricing, admission, provider, R2, history, and settlement
 * sequence so no runtime can bypass the financial or persistence contract.
 */

import { z } from "zod";
import { ApiError } from "../api/cloud-worker-errors";
import { getImageProvider } from "../providers/image/registry";
import type { ImageProvider } from "../providers/image/types";
import { getAiProviderConfigurationError } from "../providers/language-model";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { type PublicObjectBindings, putPublicObject } from "../storage/r2-public-object";
import { logger } from "../utils/logger";
import { type BillingContext, billFlatUsage, type FlatBillingCost } from "./ai-billing";
import { calculateImageGenerationCostFromCatalog } from "./ai-pricing";
import type { PricingCacheReadOptions } from "./ai-pricing/cache";
import type { FlatOperationCost } from "./ai-pricing/types";
import {
  DEFAULT_IMAGE_MODEL_ID,
  getSupportedImageModelDefinition,
  type PricingBillingSource,
  SUPPORTED_IMAGE_MODEL_IDS,
} from "./ai-pricing-definitions";
import { contentSafetyService } from "./content-safety";
import type { CreditReconciliationResult, CreditReservation } from "./credits";
import { generationsService } from "./generations";

const MAX_PROMPT_LENGTH = 4000;
const MAX_IMAGES = 4;

export const imageGenerationRequestSchema = z.object({
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

export type ImageGenerationRequest = z.infer<typeof imageGenerationRequestSchema>;

export interface ImageProviderKeys extends Record<string, string | undefined> {
  ATLASCLOUD_API_KEY?: string;
  ATLASCLOUD_BASE_URL?: string;
  FAL_KEY?: string;
  FAL_API_KEY?: string;
  FAL_RUN_BASE_URL?: string;
}

export interface ImageGenerationActor {
  organizationId: string;
  userId: string;
  apiKeyId: string | null;
}

export interface ImageGenerationAdmission {
  settle(actualCostUsd: number): Promise<CreditReconciliationResult | null>;
  settleUnknown(): Promise<CreditReconciliationResult | null>;
  markProviderDispatched?(): Promise<void>;
  reservation?: CreditReservation;
}

export interface ImageGenerationBillingInput {
  context: BillingContext & {
    provider: string;
    billingSource: PricingBillingSource;
    requestId: string;
  };
  cost: FlatOperationCost;
}

export interface ExecuteImageGenerationInput {
  input: unknown;
  actor: ImageGenerationActor;
  identity: {
    requestId: string;
    source: "http" | "app" | "personal-shared";
    affiliateCode?: string | null;
    description?: string;
    metadata?: Record<string, unknown>;
  };
  bindings: PublicObjectBindings;
  providerKeys: ImageProviderKeys;
  pricingCache?: PricingCacheReadOptions;
  admit(input: ImageGenerationBillingInput): Promise<{
    kind: "organization" | "app";
    admission: ImageGenerationAdmission;
  }>;
}

export interface ImageGenerationOutcome {
  model: string;
  provider: string;
  billingSource: PricingBillingSource;
  cost: FlatOperationCost;
  images: Array<{
    generationId: string;
    image: string;
    url: string;
    text: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}

type SafetyInput = Parameters<typeof contentSafetyService.assertSafeForPublicUse>[0];
type GenerationCreateInput = Parameters<typeof generationsService.create>[0];

export interface ImageGenerationDependencies {
  getProvider(billingSource: PricingBillingSource): ImageProvider;
  calculateCost(
    input: Parameters<typeof calculateImageGenerationCostFromCatalog>[0],
  ): Promise<FlatOperationCost>;
  assertSafe(input: SafetyInput): Promise<unknown>;
  putObject: typeof putPublicObject;
  createGeneration(input: GenerationCreateInput): Promise<{ id: string }>;
  deleteGeneration(id: string): Promise<void>;
  billFlat(
    context: BillingContext,
    cost: FlatBillingCost,
    reservation?: CreditReservation,
  ): Promise<unknown>;
  randomUuid(): string;
  now(): Date;
}

const productionDependencies: ImageGenerationDependencies = {
  getProvider: getImageProvider,
  calculateCost: calculateImageGenerationCostFromCatalog,
  assertSafe: (input) => contentSafetyService.assertSafeForPublicUse(input),
  putObject: putPublicObject,
  createGeneration: (input) => generationsService.create(input),
  deleteGeneration: (id) => generationsService.delete(id),
  billFlat: (context, cost, reservation) => billFlatUsage(context, cost, reservation),
  randomUuid: () => crypto.randomUUID(),
  now: () => new Date(),
};

interface StoredImage {
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

function imageDimensions(request: ImageGenerationRequest): Record<string, string | number> {
  const dimensions: Record<string, string | number> = {};
  if (request.width && request.height) dimensions.size = `${request.width}x${request.height}`;
  else if (request.aspectRatio) dimensions.aspectRatio = request.aspectRatio;
  if (request.stylePreset && request.stylePreset !== "none") {
    dimensions.stylePreset = request.stylePreset;
  }
  return dimensions;
}

function buildImagePrompt(request: ImageGenerationRequest): string {
  const parts = [request.prompt];
  if (request.aspectRatio) parts.push(`Aspect ratio: ${request.aspectRatio}.`);
  if (request.width && request.height) parts.push(`Canvas: ${request.width}x${request.height}.`);
  if (request.stylePreset && request.stylePreset !== "none") {
    parts.push(`Style: ${request.stylePreset}.`);
  }
  return parts.join("\n");
}

export function imageProviderKeysFromCloudEnvironment(): ImageProviderKeys {
  const env = getCloudAwareEnv();
  return {
    ATLASCLOUD_API_KEY: env.ATLASCLOUD_API_KEY,
    ATLASCLOUD_BASE_URL: env.ATLASCLOUD_BASE_URL,
    FAL_KEY: env.FAL_KEY,
    FAL_API_KEY: env.FAL_API_KEY,
    FAL_RUN_BASE_URL: env.FAL_RUN_BASE_URL,
  };
}

export function isImageGenerationConfigured(
  model: string,
  bindings: Partial<PublicObjectBindings>,
  providerKeys: ImageProviderKeys,
): boolean {
  const definition = getSupportedImageModelDefinition(model);
  if (!definition || !bindings.BLOB) return false;
  if (definition.billingSource === "atlascloud") return Boolean(providerKeys.ATLASCLOUD_API_KEY);
  if (definition.billingSource === "fal") {
    return Boolean(providerKeys.FAL_KEY || providerKeys.FAL_API_KEY);
  }
  return false;
}

async function cleanupFailedGeneration(
  deps: ImageGenerationDependencies,
  bindings: PublicObjectBindings,
  storedImages: StoredImage[],
  generationIds: string[],
): Promise<void> {
  const results = await Promise.allSettled([
    ...storedImages.map((image) => bindings.BLOB.delete(image.key)),
    ...generationIds.map((id) => deps.deleteGeneration(id)),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      // error-policy:J6 cleanup must preserve the causal generation failure.
      logger.error("[ImageGeneration] Failed to clean up a rejected image transaction", {
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
}

async function generateProviderImage(
  request: ImageGenerationRequest,
  providerKeys: ImageProviderKeys,
  provider: ImageProvider,
): Promise<Awaited<ReturnType<ImageProvider["generate"]>>> {
  try {
    return await provider.generate({
      model: request.model,
      prompt: buildImagePrompt(request),
      sourceImage: request.sourceImage,
      aspectRatio: request.aspectRatio,
      size: request.width && request.height ? `${request.width}x${request.height}` : undefined,
      apiKeys: providerKeys,
    });
  } catch (error) {
    // error-policy:J1 translate the image-provider transport boundary into a
    // sanitized retryable API failure while retaining the private error in logs.
    logger.error("[ImageGeneration] Image provider call failed", {
      model: request.model,
      billingSource: provider.billingSource,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ApiError(
      503,
      "internal_error",
      "Image generation is temporarily unavailable. Please try again shortly.",
    );
  }
}

export function createImageGenerationExecutor(deps: ImageGenerationDependencies) {
  return async function execute(
    input: ExecuteImageGenerationInput,
  ): Promise<ImageGenerationOutcome> {
    const request = imageGenerationRequestSchema.parse(input.input);
    const definition = getSupportedImageModelDefinition(request.model);
    if (!definition) {
      throw new ApiError(400, "validation_error", `Unsupported image model: ${request.model}`, {
        supportedModels: SUPPORTED_IMAGE_MODEL_IDS,
      });
    }
    if (!isImageGenerationConfigured(request.model, input.bindings, input.providerKeys)) {
      throw new ApiError(503, "internal_error", getAiProviderConfigurationError());
    }

    const [, cost] = await Promise.all([
      deps.assertSafe({
        surface: "media_generation_prompt",
        organizationId: input.actor.organizationId,
        userId: input.actor.userId,
        text: request.prompt,
        imageUrls: request.sourceImage ? [request.sourceImage] : undefined,
        allowDataImages: true,
        metadata: { type: "image", model: request.model },
      }),
      deps.calculateCost({
        model: request.model,
        provider: definition.provider,
        billingSource: definition.billingSource,
        imageCount: request.numImages,
        dimensions: {
          ...definition.defaultDimensions,
          ...imageDimensions(request),
        },
        cache: input.pricingCache,
      }),
    ]);
    const billingContext = {
      organizationId: input.actor.organizationId,
      userId: input.actor.userId,
      apiKeyId: input.actor.apiKeyId,
      model: request.model,
      provider: definition.provider,
      billingSource: definition.billingSource,
      requestId: input.identity.requestId,
      affiliateCode: input.identity.affiliateCode,
      description:
        input.identity.description ?? `Image generation: ${request.model} x${request.numImages}`,
      metadata: {
        source: input.identity.source,
        ...(input.identity.metadata ?? {}),
      },
    } satisfies ImageGenerationBillingInput["context"];
    const { kind, admission } = await input.admit({ context: billingContext, cost });

    const storedImages: StoredImage[] = [];
    const generationIds: string[] = [];
    let billingUncertain = false;
    try {
      await admission.markProviderDispatched?.();
      const provider = deps.getProvider(definition.billingSource);
      for (let index = 0; index < request.numImages; index += 1) {
        const generated = await generateProviderImage(request, input.providerKeys, provider);
        const key = `generations/images/${input.actor.organizationId}/${input.actor.userId}/${deps.randomUuid()}.${extensionForMimeType(generated.mimeType)}`;
        const stored = await deps.putObject(input.bindings, {
          key,
          body: generated.bytes,
          contentType: generated.mimeType,
          customMetadata: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            model: request.model,
            source: input.identity.source,
          },
        });
        const image: StoredImage = {
          image: generated.dataUrl,
          url: stored.url,
          key: stored.key,
          text: generated.text,
          mimeType: generated.mimeType,
          sizeBytes: generated.bytes.byteLength,
        };
        storedImages.push(image);
        await deps.assertSafe({
          surface: "media_generation_output",
          organizationId: input.actor.organizationId,
          userId: input.actor.userId,
          imageUrls: [image.url],
          metadata: { type: "image", model: request.model },
        });
      }

      for (const image of storedImages) {
        const record = await deps.createGeneration({
          organization_id: input.actor.organizationId,
          user_id: input.actor.userId,
          api_key_id: input.actor.apiKeyId,
          type: "image",
          model: request.model,
          provider: definition.provider,
          prompt: request.prompt,
          result: {
            text: image.text,
            r2Key: image.key,
            billingSource: definition.billingSource,
            source: input.identity.source,
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
          dimensions: { width: request.width, height: request.height },
          cost: String(cost.totalCost),
          credits: String(cost.totalCost),
          completed_at: deps.now(),
        });
        generationIds.push(record.id);
      }

      try {
        if (kind === "app") await admission.settle(cost.totalCost);
        else if (admission.reservation) {
          await deps.billFlat(billingContext, cost, admission.reservation);
        } else {
          await admission.settle(cost.totalCost);
        }
      } catch (error) {
        // error-policy:J7 exact accounting failure cannot turn a committed,
        // user-visible artifact into a retryable generation failure.
        billingUncertain = true;
        logger.error(
          "[ImageGeneration] Exact settlement failed; requesting conservative settlement",
          {
            requestId: billingContext.requestId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        try {
          await admission.settleUnknown();
        } catch (settlementError) {
          // error-policy:J7 the durable admission lease remains the
          // conservative accounting backstop when reconciliation is offline.
          logger.error("[ImageGeneration] Conservative settlement also failed", {
            requestId: billingContext.requestId,
            error:
              settlementError instanceof Error ? settlementError.message : String(settlementError),
          });
        }
      }

      return {
        model: request.model,
        provider: definition.provider,
        billingSource: definition.billingSource,
        cost,
        images: storedImages.map((image, index) => ({
          generationId: generationIds[index],
          image: image.image,
          url: image.url,
          text: image.text,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
        })),
      };
    } catch (error) {
      // error-policy:J6 rejected transactions remove partial artifacts while
      // preserving the causal provider, safety, storage, or history failure.
      if (!billingUncertain) {
        await cleanupFailedGeneration(deps, input.bindings, storedImages, generationIds);
        try {
          await admission.settle(0);
        } catch (settlementError) {
          // error-policy:J7 reservation-release failure is observable but must
          // not replace the causal transaction failure reported to the caller.
          logger.error("[ImageGeneration] Failed to release rejected image admission", {
            requestId: billingContext.requestId,
            error:
              settlementError instanceof Error ? settlementError.message : String(settlementError),
          });
        }
      }
      throw error;
    }
  };
}

export const executeImageGeneration = createImageGenerationExecutor(productionDependencies);
