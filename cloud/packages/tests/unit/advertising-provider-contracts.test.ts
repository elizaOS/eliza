import { afterEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_META_PAGE_ID = process.env.META_DEFAULT_PAGE_ID;
const ORIGINAL_META_VERSION = process.env.META_GRAPH_API_VERSION;
const ORIGINAL_GOOGLE_VERSION = process.env.GOOGLE_ADS_API_VERSION;

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  },
}));

mock.module("@/lib/utils/error-handling", () => ({
  extractErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_META_PAGE_ID === undefined) delete process.env.META_DEFAULT_PAGE_ID;
  else process.env.META_DEFAULT_PAGE_ID = ORIGINAL_META_PAGE_ID;
  if (ORIGINAL_META_VERSION === undefined) delete process.env.META_GRAPH_API_VERSION;
  else process.env.META_GRAPH_API_VERSION = ORIGINAL_META_VERSION;
  if (ORIGINAL_GOOGLE_VERSION === undefined) delete process.env.GOOGLE_ADS_API_VERSION;
  else process.env.GOOGLE_ADS_API_VERSION = ORIGINAL_GOOGLE_VERSION;
});

function creativeInput(overrides: Record<string, unknown> = {}) {
  return {
    campaignId: "local-campaign-id",
    name: "Launch creative",
    type: "image" as const,
    headline: "Build AI apps",
    primaryText: "Launch and monetize with Eliza Cloud.",
    description: "Cloud app builder",
    callToAction: "shop_now" as const,
    destinationUrl: "https://example.com",
    media: [],
    ...overrides,
  };
}

describe("advertising provider contracts", () => {
  test("Google creative creation splits stored account/campaign ids before mutate calls", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      const resourceName =
        calls.length === 1 ? "customers/123/adGroups/456" : "customers/123/adGroupAds/456~789";
      return new Response(JSON.stringify({ results: [{ resourceName }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { googleAdsProvider } = await import(
      `../../lib/services/advertising/providers/google.ts?case=${Date.now()}`
    );

    const result = await googleAdsProvider.createCreative(
      { accessToken: "test-access-token" },
      "123",
      "123/999",
      creativeInput(),
    );

    expect(result.success).toBe(true);
    expect(calls[0].url).toContain("/customers/123/adGroups:mutate");
    const adGroupOperation = calls[0].body.operations as Array<{ create: { campaign: string } }>;
    expect(adGroupOperation[0].create.campaign).toBe("customers/123/campaigns/999");
  });

  test("Meta creative creation requires a Page id for link ads", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "adset-1", name: "Ad Set" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const { metaAdsProvider } = await import(
      `../../lib/services/advertising/providers/meta.ts?case=${Date.now()}`
    );

    const result = await metaAdsProvider.createCreative(
      { accessToken: "test-access-token" },
      "act_123",
      "campaign-1",
      creativeInput(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("pageId");
  });

  test("Meta creative creation includes page and Instagram actor ids when provided", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (urls.length === 1) {
        return new Response(JSON.stringify({ data: [{ id: "adset-1", name: "Ad Set" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: urls.length === 2 ? "creative-1" : "ad-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { metaAdsProvider } = await import(
      `../../lib/services/advertising/providers/meta.ts?case=${Date.now()}`
    );

    const result = await metaAdsProvider.createCreative(
      { accessToken: "test-access-token" },
      "123",
      "campaign-1",
      creativeInput({ pageId: "page-1", instagramActorId: "ig-1" }),
    );

    expect(result.success).toBe(true);
    const creativeUrl = new URL(urls[1]);
    const storySpec = JSON.parse(creativeUrl.searchParams.get("object_story_spec") ?? "{}");
    expect(storySpec.page_id).toBe("page-1");
    expect(storySpec.instagram_actor_id).toBe("ig-1");
  });

  test("TikTok creative creation uses provider-native media ids and lowercase CTA inputs", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      const data = calls.length === 1 ? { adgroup_id: "adgroup-1" } : { ad_id: "ad-1" };
      return new Response(JSON.stringify({ code: 0, message: "OK", request_id: "req-1", data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { tiktokAdsProvider } = await import(
      `../../lib/services/advertising/providers/tiktok.ts?case=${Date.now()}`
    );

    const result = await tiktokAdsProvider.createCreative(
      { accessToken: "test-access-token" },
      "advertiser-1",
      "advertiser-1/campaign-1",
      creativeInput({
        media: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            source: "generation",
            url: "https://cdn.example.com/creative.png",
            providerAssetId: "image-asset-1",
            type: "image",
            order: 0,
          },
        ],
      }),
    );

    expect(result.success).toBe(true);
    expect(calls[0].body.advertiser_id).toBe("advertiser-1");
    expect(calls[0].body.campaign_id).toBe("campaign-1");
    const creatives = calls[1].body.creatives as Array<{
      call_to_action: string;
      image_ids: string[];
    }>;
    expect(creatives[0].call_to_action).toBe("SHOP_NOW");
    expect(creatives[0].image_ids).toEqual(["image-asset-1"]);
  });
});
