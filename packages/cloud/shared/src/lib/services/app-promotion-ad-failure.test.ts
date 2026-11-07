/**
 * A promotion whose ad creative is refused after the campaign was created
 * returns that campaign as a partial result instead of failing the whole
 * request, so a retry does not create and fund a second campaign. The
 * promotion service is real; the app lookup, the ad-copy model and the
 * advertising service are stubbed. The stub refuses the creative the way the
 * Snap, LinkedIn and Google providers refuse an image creative with no media.
 */
import { afterAll, expect, mock, spyOn, test } from "bun:test";

const createdCampaigns: string[] = [];
mock.module("./apps", () => ({
  appsService: {
    getById: async (id: string) => ({
      id,
      name: "Demo App",
      organization_id: "org-1",
      app_url: "https://demo.example.com",
    }),
  },
}));
mock.module("./advertising", () => ({
  advertisingService: {
    createCampaign: async () => {
      const id = `campaign-${createdCampaigns.length + 1}`;
      createdCampaigns.push(id);
      return { id, name: "Demo App - Promotion Campaign" };
    },
    createCreative: async () => {
      throw new Error(
        "Snap creatives require media.providerAssetId from a prior Snap media upload",
      );
    },
  },
}));

const posts: string[] = [];
mock.module("./social-media", () => ({
  socialMediaService: {
    createPost: async (input: { platforms: string[] }) => {
      posts.push(input.platforms[0] ?? "");
      return {
        results: [{ platform: input.platforms[0], success: true, postId: `post-${posts.length}` }],
      };
    },
  },
}));
mock.module("./seo", () => ({
  seoService: {
    createRequest: async () => {
      throw new Error("INDEXNOW_KEY is required for IndexNow submission");
    },
  },
}));

const { appPromotionService } = await import("./app-promotion");
const contentSpy = spyOn(
  appPromotionService as unknown as {
    generatePromotionalContent: (...args: unknown[]) => Promise<unknown>;
  },
  "generatePromotionalContent",
).mockResolvedValue({
  headline: "Try Demo App",
  shortDescription: "A demo app.",
  longDescription: "A demo app for testing promotions.",
  callToAction: "Learn more",
  hashtags: [],
  socialPosts: {},
});
afterAll(() => {
  contentSpy.mockRestore();
  mock.restore();
});

test("a refused ad creative returns the created campaign as a partial result", async () => {
  const result = await appPromotionService.promoteApp("org-1", "user-1", "app-1", {
    channels: ["advertising"],
    advertising: {
      platform: "snap",
      adAccountId: "11111111-1111-4111-8111-111111111111",
      budget: 50,
      budgetType: "lifetime",
      objective: "traffic",
    },
  });

  expect(createdCampaigns).toEqual(["campaign-1"]);
  expect(result.channels.advertising).toMatchObject({
    success: false,
    campaignId: "campaign-1",
  });
  expect(result.channels.advertising?.error).toContain("providerAssetId");
  expect(result.errors.length).toBeGreaterThan(0);
});

test("a failed SEO step keeps the social posts that were already published", async () => {
  const result = await appPromotionService.promoteApp("org-1", "user-1", "app-1", {
    channels: ["social", "seo"],
    social: { platforms: ["bluesky"] },
    seo: { generateMeta: true, generateSchema: true },
  } as Parameters<typeof appPromotionService.promoteApp>[3]);

  expect(posts).toEqual(["bluesky"]);
  expect(result.channels.social?.platforms[0]).toMatchObject({
    platform: "bluesky",
    success: true,
    postId: "post-1",
  });
  expect(result.channels.seo).toMatchObject({ success: false });
  expect(result.channels.seo?.error).toContain("INDEXNOW_KEY");
  expect(result.errors.length).toBeGreaterThan(0);
});

test("an advertising promotion whose ad copy fails creates no campaign", async () => {
  const before = createdCampaigns.length;
  contentSpy.mockRejectedValueOnce(new Error("model provider returned 503"));
  const result = await appPromotionService.promoteApp("org-1", "user-1", "app-1", {
    channels: ["advertising"],
    advertising: {
      platform: "snap",
      adAccountId: "11111111-1111-4111-8111-111111111111",
      budget: 50,
      budgetType: "lifetime",
      objective: "traffic",
    },
  });

  expect(createdCampaigns.length).toBe(before);
  expect(result.channels.advertising?.success).toBe(false);
  expect(result.channels.advertising?.campaignId).toBeUndefined();
  expect(result.errors.length).toBeGreaterThan(0);
});
