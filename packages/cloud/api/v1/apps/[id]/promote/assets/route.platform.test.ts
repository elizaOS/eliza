/**
 * Exercises promotion-asset route billing output and catalog-platform
 * validation through the real Hono boundary with deterministic service mocks.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type {
  AdCopyVariants,
  GeneratedAsset,
} from "@/lib/services/app-promotion-assets";

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
  apiKey: null,
}));
const getById = mock(async () => ({
  id: "app-1",
  organization_id: "org-1",
  name: "Demo",
}));
const isAppKeyOutOfScope = mock(async () => false);
const getRecommendedSizes = mock((platform: string) => {
  const recommendations: Record<string, string[]> = {
    meta: ["facebook_feed"],
    google: ["google_display_leaderboard"],
    twitter: ["twitter_card"],
    linkedin: ["linkedin_post"],
  };
  return recommendations[platform] || ["twitter_card"];
});
const AD_SIZES = {
  facebook_feed: { width: 1200, height: 628 },
  twitter_card: { width: 800, height: 418 },
  linkedin_post: { width: 1200, height: 627 },
  google_display_leaderboard: { width: 728, height: 90 },
};
const generateAssetBundle = mock(
  async (): Promise<{
    assets: GeneratedAsset[];
    copy?: AdCopyVariants;
    errors: string[];
  }> => ({
    assets: [],
    copy: undefined,
    errors: [],
  }),
);
const operationContext = {
  organizationId: "org-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "request-1",
};

mock.module("@/api-app/lib/generative-route-auth", () => ({
  requireGenerativeRouteCaller: mock(async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: null,
    authSource: "combined_cache",
    appScopeId: null,
  })),
  getGenerativeOperationContext: () => operationContext,
  asGenerativeCacheApiError: () => null,
}));
mock.module("@/lib/auth", () => ({ requireAuthOrApiKeyWithOrg }));
mock.module("@/lib/auth/app-key-scope", () => ({ isAppKeyOutOfScope }));
mock.module("@/lib/services/apps", () => ({
  appsService: { getById, update: mock(async () => undefined) },
}));
mock.module("@/lib/services/app-promotion-assets", () => ({
  AD_SIZES,
  appPromotionAssetsService: {
    getRecommendedSizes,
    generateAssetBundle,
  },
}));
mock.module("@/lib/promotion-pricing", () => ({
  AD_COPY_GENERATION_COST: 1,
  PROMO_IMAGE_COST: 2,
  estimateAssetGenerationCost: () => ({ total: 5, display: "5" }),
}));
mock.module("@/lib/services/generative-operation", () => ({
  retainGenerativeTask: mock(async (_context, _operation, task) => await task),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { info: mock(() => undefined), error: mock(() => undefined) },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:id/promote/assets", route);

describe("GET /api/v1/apps/:id/promote/assets platform identity", () => {
  beforeEach(() => {
    requireAuthOrApiKeyWithOrg.mockClear();
    getById.mockClear();
    isAppKeyOutOfScope.mockClear();
    getRecommendedSizes.mockClear();
    getById.mockResolvedValue({
      id: "app-1",
      organization_id: "org-1",
      name: "Demo",
    });
  });

  test("does not report copy credits when only image generation succeeds", async () => {
    generateAssetBundle.mockResolvedValueOnce({
      assets: [
        {
          type: "social_card",
          size: { width: 800, height: 418 },
          url: "https://example.test/asset.png",
          format: "png",
          generatedAt: new Date("2026-08-29T00:00:00.000Z"),
        },
      ],
      copy: undefined,
      errors: ["Failed to generate copy"],
    });

    const response = await app.request("/app-1/promote/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ includeCopy: true }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { creditsUsed: number };
    expect(body.creditsUsed).toBe(2);
  });

  test.each(["", "?platform="])(
    "accepts %s as the full size catalog",
    async (query) => {
      const response = await app.request(`/app-1/promote/assets${query}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { recommendedSizes: string[] };
      expect(body.recommendedSizes).toEqual(Object.keys(AD_SIZES));
      expect(getRecommendedSizes).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["meta", "facebook_feed"],
    ["google", "google_display_leaderboard"],
    ["twitter", "twitter_card"],
    ["linkedin", "linkedin_post"],
  ] as const)("accepts platform=%s as that catalog", async (token, size) => {
    const response = await app.request(
      `/app-1/promote/assets?platform=${token}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { recommendedSizes: string[] };
    expect(body.recommendedSizes).toEqual([size]);
    expect(getRecommendedSizes).toHaveBeenCalledWith(token);
  });

  test.each(["META", "Google", "facebook", "foo", "1e2"])(
    "rejects platform=%s before getRecommendedSizes",
    async (token) => {
      const response = await app.request(
        `/app-1/promote/assets?platform=${token}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_platform");
      expect(getRecommendedSizes).not.toHaveBeenCalled();
    },
  );
});
