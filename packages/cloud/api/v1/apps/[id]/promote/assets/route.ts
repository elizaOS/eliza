// Handles v1 cloud API v1 apps id promote assets route traffic with route-local auth expectations.
import { Hono } from "hono";
import { z } from "zod";
import {
  asGenerativeCacheApiError,
  getGenerativeOperationContext,
  requireGenerativeRouteCaller,
} from "@/api-app/lib/generative-route-auth";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import type { RouteContext } from "@/lib/api/hono-next-style-params";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { isAppKeyOutOfScope } from "@/lib/auth/app-key-scope";
import {
  AD_COPY_GENERATION_COST,
  estimateAssetGenerationCost,
  PROMO_IMAGE_COST,
} from "@/lib/promotion-pricing";
import {
  AD_SIZES,
  type AdSize,
  appPromotionAssetsService,
} from "@/lib/services/app-promotion-assets";
import { appsService } from "@/lib/services/apps";
import { retainGenerativeTask } from "@/lib/services/generative-operation";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const GenerateAssetsSchema = z.object({
  sizes: z
    .array(z.enum(Object.keys(AD_SIZES) as [AdSize, ...AdSize[]]))
    .optional(),
  includeCopy: z.boolean().optional(),
  includeAdBanners: z.boolean().optional(),
  targetAudience: z.string().max(500).optional(),
  customPrompt: z.string().max(1000).optional(),
});

async function __hono_POST(
  c: AppContext,
  { params }: RouteContext<{ id: string }>,
  caller: Awaited<ReturnType<typeof requireGenerativeRouteCaller>>,
) {
  const { user } = caller;
  const operationContext = getGenerativeOperationContext(c, caller);
  const { id } = await params;

  const app = await appsService.getById(id);
  if (!app || app.organization_id !== user.organization_id) {
    return Response.json({ error: "App not found" }, { status: 404 });
  }
  if (caller.appScopeId && caller.appScopeId !== id) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  const body = await c.req.json();
  const parsed = GenerateAssetsSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const imageCount = 1; // Social cards always generated (includeSocialCards: true)
  const bannerCount = parsed.data.includeAdBanners ? 1 : 0;

  logger.info("[Promote Assets API] Generating assets", {
    appId: id,
    imageCount: imageCount + bannerCount,
    includeCopy: parsed.data.includeCopy !== false,
  });

  try {
    const result = await appPromotionAssetsService.generateAssetBundle(
      app,
      {
        includeSocialCards: true,
        includeAdBanners: parsed.data.includeAdBanners,
        includeCopy: parsed.data.includeCopy,
        targetAudience: parsed.data.targetAudience,
        customPrompt: parsed.data.customPrompt,
      },
      operationContext,
    );

    const successfulImages = result.assets.length;

    if (successfulImages > 0) {
      const promotionalAssets = result.assets.map((asset) => ({
        type: asset.type as "social_card" | "banner",
        url: asset.url,
        size: { width: asset.size.width, height: asset.size.height },
        generatedAt: asset.generatedAt.toISOString(),
      }));

      await retainGenerativeTask(
        operationContext,
        {
          provider: "promotion-assets",
          billingSource: "gateway",
          model: "promotion-assets/persistence",
          operation: "promotion_assets_status_write",
          cost: 0,
        },
        appsService.update(id, {
          promotional_assets: promotionalAssets,
        }),
      );

      logger.info("[Promote Assets API] Saved promotional assets to app", {
        appId: id,
        assetCount: promotionalAssets.length,
      });
    }

    return Response.json({
      assets: result.assets.map((asset) => ({
        type: asset.type,
        size: asset.size,
        url: asset.url,
        format: asset.format,
        generatedAt: asset.generatedAt.toISOString(),
      })),
      copy: result.copy,
      errors: result.errors,
      creditsUsed:
        successfulImages * PROMO_IMAGE_COST +
        (result.copy ? AD_COPY_GENERATION_COST : 0),
    });
  } catch (error) {
    logger.error("[Promote Assets API] Generation failed", {
      appId: id,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
}

async function __hono_GET(
  request: Request,
  { params }: RouteContext<{ id: string }>,
) {
  const { user, apiKey } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await params;

  const app = await appsService.getById(id);
  if (!app || app.organization_id !== user.organization_id) {
    return Response.json({ error: "App not found" }, { status: 404 });
  }
  if (await isAppKeyOutOfScope(apiKey?.id, id)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  const url = new URL(request.url);
  // Catalog-platform identity, not leftover my-agents sortBy tax. The
  // service fallback `|| ["twitter_card"]` mapped META / facebook / foo
  // onto Twitter sizes. Missing / empty still means the full AD_SIZES
  // catalog. Garbage 400s before getRecommendedSizes.
  const requestedPlatform = url.searchParams.get("platform");
  const PROMOTE_PLATFORMS = ["meta", "google", "twitter", "linkedin"] as const;
  type PromotePlatform = (typeof PROMOTE_PLATFORMS)[number];
  if (
    requestedPlatform !== null &&
    requestedPlatform !== "" &&
    !PROMOTE_PLATFORMS.includes(requestedPlatform as PromotePlatform)
  ) {
    return Response.json(
      {
        error: "invalid_platform",
        message: 'platform must be "meta", "google", "twitter", or "linkedin".',
      },
      { status: 400 },
    );
  }
  const platform =
    requestedPlatform === "meta" ||
    requestedPlatform === "google" ||
    requestedPlatform === "twitter" ||
    requestedPlatform === "linkedin"
      ? requestedPlatform
      : null;

  const recommendedSizes = platform
    ? appPromotionAssetsService.getRecommendedSizes(platform)
    : Object.keys(AD_SIZES);

  const costEstimate = estimateAssetGenerationCost({
    imageCount: 1,
    includeCopy: true,
    includeBanner: true,
  });

  return Response.json({
    recommendedSizes,
    availableSizes: Object.entries(AD_SIZES).map(([name, dimensions]) => ({
      name,
      ...dimensions,
    })),
    estimatedCost: {
      perImage: PROMO_IMAGE_COST,
      copyGeneration: AD_COPY_GENERATION_COST,
      fullBundle: costEstimate.total,
      display: costEstimate.display,
    },
  });
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, {
    params: Promise.resolve({ id: c.req.param("id")! }),
  }),
);
__hono_app.post("/", async (c) => {
  try {
    const caller = await requireGenerativeRouteCaller(c, {
      rateLimitEndpoint: "strict",
    });
    return await __hono_POST(
      c,
      { params: Promise.resolve({ id: c.req.param("id")! }) },
      caller,
    );
  } catch (error) {
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
});
export default __hono_app;
