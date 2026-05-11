import { afterEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_META_PAGE_ID = process.env.META_DEFAULT_PAGE_ID;
const ORIGINAL_META_VERSION = process.env.META_GRAPH_API_VERSION;
const ORIGINAL_GOOGLE_VERSION = process.env.GOOGLE_ADS_API_VERSION;
const ORIGINAL_GOOGLE_DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;

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
  if (ORIGINAL_GOOGLE_DEVELOPER_TOKEN === undefined) delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  else process.env.GOOGLE_ADS_DEVELOPER_TOKEN = ORIGINAL_GOOGLE_DEVELOPER_TOKEN;
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
    }) as unknown as typeof fetch;

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

  test("Google responsive display creatives include YouTube video assets when provided", async () => {
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
    }) as unknown as typeof fetch;

    const { googleAdsProvider } = await import(
      `../../lib/services/advertising/providers/google.ts?case=${Date.now()}`
    );

    const result = await googleAdsProvider.createCreative(
      { accessToken: "test-access-token" },
      "123",
      "123/999",
      creativeInput({
        media: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            source: "generation",
            url: "https://cdn.example.com/creative.jpg",
            providerAssetId: "customers/123/assets/456",
            type: "image",
            order: 0,
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            source: "generation",
            url: "https://youtube.com/watch?v=dQw4w9WgXcQ",
            providerAssetId: "customers/123/assets/789",
            type: "video",
            order: 1,
          },
        ],
      }),
    );

    expect(result.success).toBe(true);
    const adGroupAdsOperation = calls[1].body.operations as Array<{
      create: { ad: { responsiveDisplayAd: { youtubeVideos: Array<{ asset: string }> } } };
    }>;
    expect(adGroupAdsOperation[0].create.ad.responsiveDisplayAd.youtubeVideos).toEqual([
      { asset: "customers/123/assets/789" },
    ]);
  });

  test("Meta creative creation requires a Page id for link ads", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "adset-1", name: "Ad Set" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

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
    }) as unknown as typeof fetch;

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

  test("Meta video creative creation uses provider-native video_data", async () => {
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
    }) as unknown as typeof fetch;

    const { metaAdsProvider } = await import(
      `../../lib/services/advertising/providers/meta.ts?case=${Date.now()}`
    );

    const result = await metaAdsProvider.createCreative(
      { accessToken: "test-access-token" },
      "123",
      "campaign-1",
      creativeInput({
        type: "video",
        pageId: "page-1",
        media: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            source: "generation",
            url: "https://cdn.example.com/creative.mp4",
            providerAssetId: "meta-video-id",
            type: "video",
            order: 0,
          },
        ],
      }),
    );

    expect(result.success).toBe(true);
    const creativeUrl = new URL(urls[1]);
    const storySpec = JSON.parse(creativeUrl.searchParams.get("object_story_spec") ?? "{}");
    expect(storySpec.page_id).toBe("page-1");
    expect(storySpec.video_data.video_id).toBe("meta-video-id");
    expect(storySpec.video_data.call_to_action.value.link).toBe("https://example.com");
    expect(storySpec.link_data).toBeUndefined();
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
    }) as unknown as typeof fetch;

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

  test("TikTok media upload maps public media URL to provider asset id", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(
        JSON.stringify({
          code: 0,
          message: "OK",
          request_id: "req-1",
          data: { image_id: "image-asset-1" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const { tiktokAdsProvider } = await import(
      `../../lib/services/advertising/providers/tiktok.ts?case=${Date.now()}`
    );

    const result = await tiktokAdsProvider.uploadMedia?.(
      { accessToken: "test-access-token" },
      "advertiser-1",
      {
        type: "image",
        name: "Launch card",
        url: "https://example.com/creative.png",
      },
    );

    expect(result?.success).toBe(true);
    expect(result?.providerAssetId).toBe("image-asset-1");
    expect(calls[0].url).toContain("/file/image/ad/upload/");
    expect(calls[0].body.upload_type).toBe("UPLOAD_BY_URL");
    expect(calls[0].body.image_url).toBe("https://example.com/creative.png");
  });

  test("Meta media upload returns image hash for creative image_hash", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      if (String(input).startsWith("https://example.com/")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "3" },
        });
      }
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(
        JSON.stringify({
          images: {
            "creative.png": { hash: "meta-image-hash", url: "https://meta.example/image.png" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const { metaAdsProvider } = await import(
      `../../lib/services/advertising/providers/meta.ts?case=${Date.now()}`
    );

    const result = await metaAdsProvider.uploadMedia?.(
      { accessToken: "test-access-token" },
      "123",
      {
        type: "image",
        name: "creative.png",
        url: "https://example.com/creative.png",
      },
    );

    expect(result?.success).toBe(true);
    expect(result?.providerAssetId).toBe("meta-image-hash");
    expect(calls[1]).toContain("/act_123/adimages");
  });

  test("Meta media upload maps public video URL to Ad Video id", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ id: "meta-video-id" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { metaAdsProvider } = await import(
      `../../lib/services/advertising/providers/meta.ts?case=${Date.now()}`
    );

    const result = await metaAdsProvider.uploadMedia?.(
      { accessToken: "test-access-token" },
      "123",
      {
        type: "video",
        name: "launch-video",
        url: "https://example.com/creative.mp4",
      },
    );

    expect(result?.success).toBe(true);
    expect(result?.providerAssetId).toBe("meta-video-id");
    const uploadUrl = new URL(calls[0]);
    expect(uploadUrl.pathname).toContain("/act_123/advideos");
    expect(uploadUrl.searchParams.get("file_url")).toBe("https://example.com/creative.mp4");
  });

  test("Google media upload creates an ImageAsset resource", async () => {
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "developer-token";
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (String(input).startsWith("https://example.com/")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-length": "3" },
        });
      }
      return new Response(
        JSON.stringify({ results: [{ resourceName: "customers/123/assets/456" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const { googleAdsProvider } = await import(
      `../../lib/services/advertising/providers/google.ts?case=${Date.now()}`
    );

    const result = await googleAdsProvider.uploadMedia?.(
      { accessToken: "test-access-token" },
      "123",
      {
        type: "image",
        name: "Marketing Image",
        url: "https://example.com/creative.jpg",
      },
    );

    expect(result?.success).toBe(true);
    expect(result?.providerAssetId).toBe("customers/123/assets/456");
    expect(calls[1].url).toContain("/customers/123/assets:mutate");
    const operations = calls[1].body?.operations as Array<{
      create: { type: string; imageAsset: { data: string; mimeType: string } };
    }>;
    expect(operations[0].create.type).toBe("IMAGE");
    expect(operations[0].create.imageAsset.data).toBe("AQID");
    expect(operations[0].create.imageAsset.mimeType).toBe("IMAGE_JPEG");
  });

  test("Google media upload creates a YouTubeVideoAsset resource from a YouTube URL", async () => {
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "developer-token";
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(
        JSON.stringify({ results: [{ resourceName: "customers/123/assets/789" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const { googleAdsProvider } = await import(
      `../../lib/services/advertising/providers/google.ts?case=${Date.now()}`
    );

    const result = await googleAdsProvider.uploadMedia?.(
      { accessToken: "test-access-token" },
      "123",
      {
        type: "video",
        name: "Launch video",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      },
    );

    expect(result?.success).toBe(true);
    expect(result?.providerAssetId).toBe("customers/123/assets/789");
    const operations = calls[0].body?.operations as Array<{
      create: { type: string; youtubeVideoAsset: { youtubeVideoId: string } };
    }>;
    expect(operations[0].create.type).toBe("YOUTUBE_VIDEO");
    expect(operations[0].create.youtubeVideoAsset.youtubeVideoId).toBe("dQw4w9WgXcQ");
  });

  test("Google media upload starts resumable YouTube upload for raw video URLs", async () => {
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "developer-token";
    const calls: Array<{ url: string; body?: unknown; headers?: Headers }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: init?.body,
        headers: new Headers(init?.headers),
      });
      if (String(input).startsWith("https://example.com/")) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "video/mp4", "content-length": "4" },
        });
      }
      if (String(input).includes("/youTubeVideoUploads:create")) {
        return new Response("", {
          status: 200,
          headers: { "x-goog-upload-url": "https://uploads.google.test/session-1" },
        });
      }
      return new Response(
        JSON.stringify({ resourceName: "customers/123/youTubeVideoUploads/abc" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const { googleAdsProvider } = await import(
      `../../lib/services/advertising/providers/google.ts?case=${Date.now()}`
    );

    const result = await googleAdsProvider.uploadMedia?.(
      { accessToken: "test-access-token" },
      "123",
      {
        type: "video",
        name: "Launch video",
        url: "https://example.com/creative.mp4",
      },
    );

    expect(result?.success).toBe(true);
    expect(result?.providerAssetId).toBe("customers/123/youTubeVideoUploads/abc");
    expect(calls[1].url).toContain("/resumable/upload/");
    expect(calls[1].headers?.get("x-goog-upload-protocol")).toBe("resumable");
    expect(calls[2].url).toBe("https://uploads.google.test/session-1");
    expect(calls[2].headers?.get("x-goog-upload-command")).toBe("upload, finalize");
  });
});
