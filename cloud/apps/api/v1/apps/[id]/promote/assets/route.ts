import { Hono } from "hono";
import { z } from "zod";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
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
import { creditsService } from "@/lib/services/credits";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const GenerateAssetsSchema = z.object({
  sizes: z.array(z.enum(Object.keys(AD_SIZES) as [AdSize, ...AdSize[]])).optional(),
  includeCopy: z.boolean().optional(),
  includeAdBanners: z.boolean().optional(),
  targetAudience: z.string().max(500).optional(),
  customPrompt: z.string().max(1000).optional(),
});

async function __hono_POST(request: Request, { params }: RouteParams) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await params;

  const app = await appsService.getById(id);
  if (!app || app.organization_id !== user.organization_id) {
    return Response.json({ error: "App not found" }, { status: 404 });
  }

  const body = await request.json();
  const parsed = GenerateAssetsSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Calculate cost - 1 social card always generated + 1 banner (if requested)
  const imageCount = 1; // Social cards always generated (includeSocialCards: true)
  const bannerCount = parsed.data.includeAdBanners ? 1 : 0;
  const totalImageCost = (imageCount + bannerCount) * PROMO_IMAGE_COST;
  const copyCost = parsed.data.includeCopy !== false ? AD_COPY_GENERATION_COST : 0;
  const totalCost = totalImageCost + copyCost;

  const deduction = await creditsService.deductCredits({
    organizationId: user.organization_id,
    amount: totalCost,
    description: `Generate promotional assets for ${app.name}`,
    metadata: { appId: id, imageCount: imageCount + bannerCount },
  });

  if (!deduction.success) {
    return Response.json({ error: "Insufficient credits", required: totalCost }, { status: 402 });
  }

  logger.info("[Promote Assets API] Generating assets", {
    appId: id,
    imageCount: imageCount + bannerCount,
    includeCopy: parsed.data.includeCopy !== false,
  });

  try {
    const result = await appPromotionAssetsService.generateAssetBundle(app, {
      includeSocialCards: true,
      includeAdBanners: parsed.data.includeAdBanners,
      includeCopy: parsed.data.includeCopy,
      targetAudience: parsed.data.targetAudience,
      customPrompt: parsed.data.customPrompt,
    });

    // Refund for failed generations
    const successfulImages = result.assets.length;
    const failedImages = imageCount + bannerCount - successfulImages;
    if (failedImages > 0) {
      await creditsService.refundCredits({
        organizationId: user.organization_id,
        amount: failedImages * PROMO_IMAGE_COST,
        description: "Refund for failed asset generations",
        metadata: { appId: id, failedCount: failedImages },
      });
    }

    if (successfulImages > 0) {
      const promotionalAssets = result.assets.map((asset) => ({
        type: asset.type as "social_card" | "banner",
        url: asset.url,
        size: { width: asset.size.width, height: asset.size.height },
        generatedAt: asset.generatedAt.toISOString(),
      }));

      await appsService.update(id, {
        promotional_assets: promotionalAssets,
      });

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
      creditsUsed: totalCost - failedImages * PROMO_IMAGE_COST,
    });
  } catch (error) {
    // Full refund on complete failure
    await creditsService.refundCredits({
      organizationId: user.organization_id,
      amount: totalCost,
      description: "Refund for failed asset generation",
      metadata: { appId: id, reason: "generation_error" },
    });

    logger.error("[Promote Assets API] Generation failed", {
      appId: id,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    return Response.json(
      { error: "Failed to generate assets. Credits have been refunded." },
      { status: 500 },
    );
  }
}

async function __hono_GET(request: Request, { params }: RouteParams) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await params;

  const app = await appsService.getById(id);
  if (!app || app.organization_id !== user.organization_id) {
    return Response.json({ error: "App not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const platform = url.searchParams.get("platform") as
    | "meta"
    | "google"
    | "twitter"
    | "linkedin"
    | null;

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
  __hono_GET(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
export default __hono_app;
