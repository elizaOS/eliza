/**
 * Proves paid app review, promotion, asset, and automation POST routes stop at
 * the shared standing boundary before any provider-backed service can run.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { ApiError } from "@/lib/api/cloud-worker-errors";

const requireGenerativeRouteCaller = mock(async () => {
  throw new ApiError(403, "access_denied", "Organization is inactive", {
    reason: "organization_inactive",
  });
});
const runAppReview = mock(async () => ({ disposition: "allow" }));
const promoteApp = mock(async () => ({ totalCreditsUsed: 0, errors: [] }));
const generateAssetBundle = mock(async () => ({
  assets: [],
  copy: null,
  errors: [],
}));
const postAppTweet = mock(async () => ({ success: true }));
const postTelegramAnnouncement = mock(async () => ({ success: true }));
const postDiscordAnnouncement = mock(async () => ({ success: true }));
const generateAppTweet = mock(async () => ({
  text: "preview",
  type: "promotional",
}));
const generateTelegramAnnouncement = mock(async () => "preview");
const generateDiscordAnnouncement = mock(async () => "preview");
const deductCredits = mock(async () => ({ success: true }));

mock.module("@/api-app/lib/generative-route-auth", () => ({
  asGenerativeCacheApiError: (error: unknown) => error,
  deferredCredentialAdmissionGuard: () => ({
    credentialForAdmission: () => undefined,
    async [Symbol.asyncDispose]() {},
  }),
  getGenerativeOperationContext: () => ({
    organizationId: "org-1",
    userId: "user-1",
    apiKeyId: null,
    requestId: "request-1",
  }),
  requireGenerativeRouteCaller,
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { CRITICAL: {}, STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: mock(async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKey: null,
  })),
}));
mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope: mock(async () => false),
}));
mock.module("@/lib/services/apps", () => ({
  appsService: {
    getById: mock(async () => ({
      id: "app-1",
      organization_id: "org-1",
      name: "Demo",
    })),
    update: mock(async () => undefined),
  },
}));
mock.module("@/lib/services/app-review", () => ({
  getLatestAppReview: mock(async () => null),
  runAppReview,
}));
mock.module("@/lib/services/app-promotion", () => ({
  appPromotionService: {
    getPromotionHistory: mock(async () => []),
    getPromotionSuggestions: mock(async () => []),
    promoteApp,
  },
}));
mock.module("@/lib/services/app-promotion-assets", () => ({
  AD_SIZES: {
    twitter_card: { width: 800, height: 418 },
  },
  appPromotionAssetsService: {
    getRecommendedSizes: mock(() => []),
    generateAssetBundle,
  },
}));
mock.module("@/lib/promotion-pricing", () => ({
  AD_COPY_GENERATION_COST: 1,
  PROMO_IMAGE_COST: 2,
  estimateAssetGenerationCost: () => ({ total: 5 }),
}));
mock.module("@/lib/services/credits", () => ({
  COST_BUFFER: 1.5,
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
  MIN_RESERVATION: 0.000001,
  RESERVATION_SWEEP_GRACE_MS: 0,
  ReservationNotFoundError: class ReservationNotFoundError extends Error {},
  creditsService: {
    deductCredits,
    refundCredits: mock(async () => undefined),
  },
}));
mock.module("@/lib/services/generative-operation", () => ({
  isGenerativeOperationAdmissionError: mock(() => false),
  retainGenerativeTask: mock(async () => undefined),
}));
mock.module("@/lib/services/twitter-automation/app-automation", () => ({
  twitterAppAutomationService: { postAppTweet, generateAppTweet },
}));
mock.module("@/lib/services/telegram-automation/app-automation", () => ({
  telegramAppAutomationService: {
    postAnnouncement: postTelegramAnnouncement,
    generateAnnouncement: generateTelegramAnnouncement,
  },
}));
mock.module("@/lib/services/discord-automation/app-automation", () => ({
  discordAppAutomationService: {
    postAnnouncement: postDiscordAnnouncement,
    generateAnnouncement: generateDiscordAnnouncement,
  },
}));
mock.module("@/lib/services/automation-constants", () => ({
  getTwitterConfigWithDefaults: (value: unknown) => value ?? {},
  getTelegramConfigWithDefaults: (value: unknown) => value ?? {},
  getDiscordConfigWithDefaults: (value: unknown) => value ?? {},
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const [
  { default: reviewRoute },
  { default: promoteRoute },
  { default: assetsRoute },
  { default: twitterPostRoute },
  { default: telegramPostRoute },
  { default: discordPostRoute },
  { default: promotionPreviewRoute },
] = await Promise.all([
  import("../v1/apps/[id]/review/route"),
  import("../v1/apps/[id]/promote/route"),
  import("../v1/apps/[id]/promote/assets/route"),
  import("../v1/apps/[id]/twitter-automation/post/route"),
  import("../v1/apps/[id]/telegram-automation/post/route"),
  import("../v1/apps/[id]/discord-automation/post/route"),
  import("../v1/apps/[id]/promote/preview/route"),
]);

const app = new Hono()
  .route("/apps/:id/review", reviewRoute)
  .route("/apps/:id/promote", promoteRoute)
  .route("/apps/:id/promote/assets", assetsRoute)
  .route("/apps/:id/twitter-automation/post", twitterPostRoute)
  .route("/apps/:id/telegram-automation/post", telegramPostRoute)
  .route("/apps/:id/discord-automation/post", discordPostRoute)
  .route("/apps/:id/promote/preview", promotionPreviewRoute);

const providerBackedCalls = [
  runAppReview,
  promoteApp,
  generateAssetBundle,
  postAppTweet,
  postTelegramAnnouncement,
  postDiscordAnnouncement,
  generateAppTweet,
  generateTelegramAnnouncement,
  generateDiscordAnnouncement,
];

describe("paid app routes standing gate", () => {
  beforeEach(() => {
    requireGenerativeRouteCaller.mockClear();
    deductCredits.mockClear();
    for (const call of providerBackedCalls) call.mockClear();
  });

  test.each([
    ["review", "/apps/app-1/review", {}],
    ["promotion", "/apps/app-1/promote", { channels: ["social"] }],
    ["promotion assets", "/apps/app-1/promote/assets", {}],
    ["Twitter automation", "/apps/app-1/twitter-automation/post", {}],
    ["Telegram automation", "/apps/app-1/telegram-automation/post", {}],
    ["Discord automation", "/apps/app-1/discord-automation/post", {}],
    [
      "promotion preview",
      "/apps/app-1/promote/preview",
      { platforms: ["twitter", "telegram", "discord"], count: 1 },
    ],
  ])(
    "denies %s before credit or provider dispatch",
    async (_name, path, body) => {
      const response = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "access_denied",
        error: "Organization is inactive",
        details: { reason: "organization_inactive" },
      });
      expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(1);
      expect(deductCredits).not.toHaveBeenCalled();
      for (const call of providerBackedCalls)
        expect(call).not.toHaveBeenCalled();
    },
  );
});
