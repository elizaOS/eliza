/** Authenticates image requests and delegates the canonical Cloud image transaction. */

import { Hono } from "hono";
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
import { admitAppInferenceCacheOnly } from "@/lib/services/app-inference-admission";
import { appsService } from "@/lib/services/apps";
import { InsufficientCreditsError } from "@/lib/services/credits";
import {
  executeImageGeneration,
  imageGenerationRequestSchema,
  imageProviderKeysFromCloudEnvironment,
} from "@/lib/services/image-generation";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

export async function handleGenerateImagePOST(
  c: AppContext,
  options: { requiredAppId?: string } = {},
): Promise<Response> {
  try {
    const { user, apiKeyId, admissionSnapshot, appScopeId } =
      await requireGenerativeRouteCaller(c, { rateLimitEndpoint: "strict" });
    const executionCtx = getGenerativeExecutionContext(c);
    let inferenceApp: Awaited<ReturnType<typeof appsService.getById>> | null =
      null;
    if (options.requiredAppId) {
      if (appScopeId && appScopeId !== options.requiredAppId) {
        return jsonError(c, 403, "Access denied to this app", "access_denied");
      }
      const resolution = executionCtx
        ? await appsService.getByIdCacheOnly(options.requiredAppId, {
            executionCtx,
          })
        : {
            kind: "ready" as const,
            app: (await appsService.getById(options.requiredAppId)) ?? null,
          };
      if (resolution.kind !== "ready") {
        throw new ApiError(
          503,
          "service_unavailable",
          "App cache is warming; retry shortly",
        );
      }
      inferenceApp = resolution.app;
      if (!inferenceApp) {
        return jsonError(c, 404, "App not found", "resource_not_found");
      }
      if (
        !inferenceApp.monetization_enabled &&
        inferenceApp.organization_id !== user.organization_id
      ) {
        return jsonError(c, 403, "Access denied to this app", "access_denied");
      }
    }
    if (!c.env.BLOB) {
      return jsonError(
        c,
        503,
        "R2 storage is not configured",
        "internal_error",
      );
    }

    const request = imageGenerationRequestSchema.parse(await c.req.json());
    const idempotencyKey = c.req.header("Idempotency-Key")?.trim();
    const requestId =
      options.requiredAppId && idempotencyKey
        ? `app-image:${options.requiredAppId}:${user.id}:${idempotencyKey.slice(0, 200)}`
        : `generate-image:${crypto.randomUUID()}`;
    const outcome = await executeImageGeneration({
      input: request,
      actor: {
        organizationId: user.organization_id,
        userId: user.id,
        apiKeyId,
      },
      identity: {
        requestId,
        source: options.requiredAppId ? "app" : "http",
        affiliateCode: c.req.header("X-Affiliate-Code"),
      },
      bindings: c.env,
      providerKeys: imageProviderKeysFromCloudEnvironment(),
      pricingCache: getGenerativePricingCacheOptions(c),
      admit: async ({ context, cost }) => {
        if (inferenceApp && options.requiredAppId && executionCtx) {
          const admission = await admitAppInferenceCacheOnly({
            app: inferenceApp,
            appId: options.requiredAppId,
            userId: user.id,
            organizationId: user.organization_id,
            estimatedBaseCostUsd: cost.totalCost,
            description: context.description ?? "Image generation",
            idempotencyKey: idempotencyKey ?? requestId,
            requestId,
            model: request.model,
            provider: context.provider,
            billingSource: context.billingSource,
            affiliateCode: context.affiliateCode,
            executionCtx,
            admissionSnapshot,
            metadata: {
              endpoint: "apps.generate-image",
              numImages: request.numImages,
            },
          });
          return { kind: "app" as const, admission };
        }
        const admission = await admitFlatGenerativeOperation({
          c,
          context,
          apiKeyId,
          cost,
          admissionSnapshot,
        });
        return { kind: "organization" as const, admission };
      },
    });

    return c.json({
      success: true,
      ...(options.requiredAppId ? { appId: options.requiredAppId } : {}),
      model: outcome.model,
      images: outcome.images.map(({ image, url, text }) => ({
        image,
        url,
        text,
      })),
      cost: outcome.cost,
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
    logger.error("[GenerateImage] Generation failed", {
      error: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
}

app.post("/", (c) => handleGenerateImagePOST(c));

app.all("*", (c) =>
  c.json({ success: false, error: "Method not allowed" }, 405),
);

export default app;
