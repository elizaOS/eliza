// Exercises reddit behavior with deterministic cloud-shared lib fixtures.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { redditAdsProvider } from "./reddit";

const originalFetch = globalThis.fetch;

type FetchCall = {
  url: string;
  init?: RequestInit;
};

const calls: FetchCall[] = [];
let queue: Array<{ ok?: boolean; status?: number; body: unknown }> = [];

function enqueue(body: unknown, options: { ok?: boolean; status?: number } = {}) {
  queue.push({ body, ...options });
}

function jsonBody(call: FetchCall): unknown {
  return JSON.parse(String(call.init?.body ?? "{}"));
}

beforeEach(() => {
  calls.length = 0;
  queue = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift() ?? { body: { data: {} }, ok: true, status: 200 };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? (next.ok === false ? 400 : 200),
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("redditAdsProvider", () => {
  test("discovers ad accounts through the authenticated user's businesses", async () => {
    enqueue({ data: [{ id: "biz_1", name: "Business" }] });
    enqueue({ data: [{ id: "t2_account", name: "Reddit Account" }] });

    const accounts = await redditAdsProvider.listAdAccounts({ accessToken: "token" });

    expect(accounts).toEqual([{ id: "t2_account", name: "Reddit Account" }]);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/v3/me/businesses",
      "/api/v3/businesses/biz_1/ad_accounts",
    ]);
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: "Bearer token" });
  });

  test("creates a paused Reddit campaign and ad group with mapped budget, bid, and targeting", async () => {
    enqueue({ data: { id: "cmp_1" } });
    enqueue({ data: { id: "grp_1" } });

    const result = await redditAdsProvider.createCampaign({ accessToken: "token" }, "t2_account", {
      organizationId: "org",
      adAccountId: "local-account",
      name: "Launch Campaign",
      objective: "traffic",
      budgetType: "daily",
      budgetAmount: 25,
      bidStrategy: "cpc",
      optimizationGoal: "clicks",
      targeting: {
        locations: ["US"],
        interests: ["gaming"],
        behaviors: ["indie apps"],
        placements: ["FEED"],
        genders: ["male"],
      },
    });

    expect(result).toEqual({
      success: true,
      externalCampaignId: "t2_account/cmp_1/grp_1",
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/v3/ad_accounts/t2_account/campaigns",
      "/api/v3/ad_accounts/t2_account/ad_groups",
    ]);
    expect(jsonBody(calls[0] as FetchCall)).toMatchObject({
      data: {
        name: "Launch Campaign",
        objective: "CLICKS",
        configured_status: "PAUSED",
        is_campaign_budget_optimization: false,
      },
    });
    expect(jsonBody(calls[1] as FetchCall)).toMatchObject({
      data: {
        campaign_id: "cmp_1",
        configured_status: "PAUSED",
        goal_type: "DAILY_SPEND",
        goal_value: 25_000_000,
        bid_type: "CPC",
        optimization_goal: "CLICKS",
        targeting: {
          geolocations: ["US"],
          interests: ["gaming"],
          keywords: ["indie apps"],
          locations: ["FEED"],
          gender: "MALE",
        },
      },
    });
  });

  test("creates a Reddit post and ad creative against the composite campaign id", async () => {
    enqueue({ data: { id: "post_1" } });
    enqueue({ data: { id: "ad_1" } });
    const media = [
      {
        id: "00000000-0000-4000-8000-000000000002",
        source: "upload" as const,
        url: "https://cdn.example.com/ad-second.png",
        type: "image" as const,
        order: 1,
      },
      {
        id: "00000000-0000-4000-8000-000000000001",
        source: "upload" as const,
        url: "https://cdn.example.com/ad-first.png",
        type: "image" as const,
        order: 0,
      },
    ];

    const result = await redditAdsProvider.createCreative(
      { accessToken: "token" },
      "t2_account",
      "t2_account/cmp_1/grp_1",
      {
        campaignId: "campaign-local",
        name: "Launch Creative",
        type: "image",
        headline: "Try the app",
        primaryText: "A useful app for builders",
        callToAction: "learn_more",
        destinationUrl: "https://example.com",
        pageId: "profile_1",
        media,
      },
    );

    expect(result).toEqual({ success: true, externalCreativeId: "post_1/ad_1" });
    expect(media.map((item) => item.url)).toEqual([
      "https://cdn.example.com/ad-second.png",
      "https://cdn.example.com/ad-first.png",
    ]);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/v3/profiles/profile_1/posts",
      "/api/v3/ad_accounts/t2_account/ads",
    ]);
    expect(jsonBody(calls[0] as FetchCall)).toMatchObject({
      data: {
        type: "IMAGE",
        headline: "Try the app",
        content: [
          {
            media_url: "https://cdn.example.com/ad-first.png",
            destination_url: "https://example.com",
            call_to_action: "Learn More",
          },
          {
            media_url: "https://cdn.example.com/ad-second.png",
            destination_url: "https://example.com",
            call_to_action: "Learn More",
          },
        ],
      },
    });
    expect(jsonBody(calls[1] as FetchCall)).toMatchObject({
      data: {
        name: "Launch Creative",
        ad_group_id: "grp_1",
        post_id: "post_1",
        click_url: "https://example.com",
        configured_status: "PAUSED",
      },
    });
  });

  test("creates a Reddit creative from an account/campaign id by discovering an ad group and profile", async () => {
    enqueue({ data: [{ id: "grp_1" }] });
    enqueue({ data: [{ id: "profile_1" }] });
    enqueue({ data: { id: "post_1" } });
    enqueue({ data: { id: "ad_1" } });

    const result = await redditAdsProvider.createCreative(
      { accessToken: "token" },
      "t2_account",
      "t2_account/cmp_1",
      {
        campaignId: "campaign-local",
        name: "Launch Creative",
        type: "image",
        destinationUrl: "https://example.com",
        media: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            source: "upload",
            url: "https://cdn.example.com/ad.png",
            type: "image",
            order: 0,
          },
        ],
      },
    );

    expect(result).toEqual({ success: true, externalCreativeId: "post_1/ad_1" });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/v3/ad_accounts/t2_account/ad_groups",
      "/api/v3/ad_accounts/t2_account/profiles",
      "/api/v3/profiles/profile_1/posts",
      "/api/v3/ad_accounts/t2_account/ads",
    ]);
    expect(new URL(calls[0]?.url ?? "").searchParams.get("campaign_id")).toBe("cmp_1");
  });

  test("patches campaign and ad group status for pause and activation", async () => {
    enqueue({ data: { id: "cmp_1" } });
    enqueue({ data: { id: "grp_1" } });
    enqueue({ data: { id: "cmp_1" } });
    enqueue({ data: { id: "grp_1" } });

    await expect(
      redditAdsProvider.pauseCampaign({ accessToken: "token" }, "t2_account/cmp_1/grp_1"),
    ).resolves.toMatchObject({ success: true });
    await expect(
      redditAdsProvider.activateCampaign({ accessToken: "token" }, "t2_account/cmp_1/grp_1"),
    ).resolves.toMatchObject({ success: true });

    expect(jsonBody(calls[0] as FetchCall)).toEqual({ data: { configured_status: "PAUSED" } });
    expect(jsonBody(calls[1] as FetchCall)).toEqual({ data: { configured_status: "PAUSED" } });
    expect(jsonBody(calls[2] as FetchCall)).toEqual({ data: { configured_status: "ACTIVE" } });
    expect(jsonBody(calls[3] as FetchCall)).toEqual({ data: { configured_status: "ACTIVE" } });
  });

  test("updates and archives campaign resources", async () => {
    enqueue({ data: { id: "cmp_1" } });
    enqueue({ data: { id: "grp_1" } });
    enqueue({ data: { id: "grp_1" } });
    enqueue({ data: { id: "cmp_1" } });

    await expect(
      redditAdsProvider.updateCampaign({ accessToken: "token" }, "t2_account/cmp_1/grp_1", {
        name: "Renamed",
        budgetAmount: 50,
        endDate: new Date("2026-07-10T00:00:00Z"),
      }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      redditAdsProvider.deleteCampaign({ accessToken: "token" }, "t2_account/cmp_1/grp_1"),
    ).resolves.toMatchObject({ success: true });

    expect(jsonBody(calls[0] as FetchCall)).toEqual({
      data: {
        name: "Renamed",
        end_time: "2026-07-10T00:00:00.000Z",
        spend_cap: 50_000_000,
      },
    });
    expect(jsonBody(calls[1] as FetchCall)).toEqual({ data: { goal_value: 50_000_000 } });
    expect(jsonBody(calls[2] as FetchCall)).toEqual({
      data: { configured_status: "ARCHIVED" },
    });
    expect(jsonBody(calls[3] as FetchCall)).toEqual({
      data: { configured_status: "ARCHIVED" },
    });
  });

  test("maps hosted media URLs into stable Reddit external URL assets and rejects unsafe URLs", async () => {
    await expect(
      redditAdsProvider.uploadMedia?.({ accessToken: "token" }, "t2_account", {
        name: "Launch Creative",
        type: "image",
        url: "https://example.com/ad.png",
      }),
    ).resolves.toMatchObject({
      success: true,
      providerAssetId: "reddit-url:Launch-Creative",
      providerAssetUrl: "https://example.com/ad.png",
      providerAssetResourceName: "https://example.com/ad.png",
      metadata: { storage: "external_url", type: "image" },
    });

    await expect(
      redditAdsProvider.uploadMedia?.({ accessToken: "token" }, "t2_account", {
        type: "image",
        url: "http://127.0.0.1/ad.png",
      }),
    ).resolves.toMatchObject({
      success: false,
      error: "Private or reserved IP addresses are not allowed",
    });
  });

  test("queries Reddit reports and sums campaign metrics", async () => {
    enqueue({
      data: [
        { SPEND: "12.5", IMPRESSIONS: "1000", CLICKS: "25", CONVERSIONS: "2" },
        { SPEND: 7.5, IMPRESSIONS: 500, CLICKS: 5, CONVERSIONS: 1 },
      ],
    });

    const result = await redditAdsProvider.getCampaignMetrics(
      { accessToken: "token" },
      "t2_account/cmp_1/grp_1",
      {
        start: new Date("2026-07-01T12:34:00Z"),
        end: new Date("2026-07-02T12:34:00Z"),
      },
    );

    expect(result).toEqual({
      success: true,
      metrics: {
        spend: 20,
        impressions: 1500,
        clicks: 30,
        conversions: 3,
        ctr: 0.02,
        cpc: 20 / 30,
        cpm: (20 / 1500) * 1000,
      },
    });
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v3/ad_accounts/t2_account/reports");
    expect(jsonBody(calls[0] as FetchCall)).toMatchObject({
      data: {
        starts_at: "2026-07-01T12:00:00Z",
        ends_at: "2026-07-02T12:00:00Z",
        fields: ["SPEND", "IMPRESSIONS", "CLICKS", "CONVERSIONS"],
        breakdowns: ["CAMPAIGN_ID"],
      },
    });
  });

  test("queries Reddit reports from a two-part account/campaign id", async () => {
    enqueue({ data: [] });

    const result = await redditAdsProvider.getCampaignMetrics(
      { accessToken: "token" },
      "t2_account/cmp_1",
      {
        start: new Date("2026-07-01T12:34:00Z"),
        end: new Date("2026-07-02T12:34:00Z"),
      },
    );

    expect(result).toMatchObject({ success: true });
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v3/ad_accounts/t2_account/reports");
    expect(jsonBody(calls[0] as FetchCall)).toMatchObject({
      data: {
        filter: {
          field: "CAMPAIGN_ID",
          operator: "IN",
          values: ["cmp_1"],
        },
      },
    });
  });
});
