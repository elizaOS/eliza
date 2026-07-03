import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { xTwitterAdsProvider } from "./x-twitter";

const originalFetch = globalThis.fetch;
const originalConsumerKey = process.env.X_ADS_CONSUMER_KEY;
const originalConsumerSecret = process.env.X_ADS_CONSUMER_SECRET;

type FetchCall = {
  url: string;
  init?: RequestInit;
};

const calls: FetchCall[] = [];
let queue: Array<{ status?: number; body: unknown }> = [];

function enqueue(body: unknown, status = 200) {
  queue.push({ body, status });
}

function query(call: FetchCall): URLSearchParams {
  return new URL(call.url).searchParams;
}

beforeEach(() => {
  process.env.X_ADS_CONSUMER_KEY = "consumer-key";
  process.env.X_ADS_CONSUMER_SECRET = "consumer-secret";
  calls.length = 0;
  queue = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift() ?? { body: { data: {} }, status: 200 };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalConsumerKey === undefined) delete process.env.X_ADS_CONSUMER_KEY;
  else process.env.X_ADS_CONSUMER_KEY = originalConsumerKey;
  if (originalConsumerSecret === undefined) delete process.env.X_ADS_CONSUMER_SECRET;
  else process.env.X_ADS_CONSUMER_SECRET = originalConsumerSecret;
});

describe("xTwitterAdsProvider", () => {
  test("discovers accessible X Ads accounts with OAuth 1.0a", async () => {
    enqueue({ data: [{ id: "18ce54d4x5t", name: "X Ads Account" }] });

    const accounts = await xTwitterAdsProvider.listAdAccounts({
      accessToken: "user-token",
      refreshToken: "token-secret",
    });

    expect(accounts).toEqual([{ id: "18ce54d4x5t", name: "X Ads Account" }]);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/12/accounts");
    const authHeader = String((calls[0]?.init?.headers as Record<string, string>).Authorization);
    expect(authHeader).toContain('oauth_consumer_key="consumer-key"');
    expect(authHeader).toContain('oauth_token="user-token"');
  });

  test("creates a paused campaign and line item under the first active funding instrument", async () => {
    enqueue({ data: [{ id: "fund_1", entity_status: "ACTIVE" }] });
    enqueue({ data: { id: "camp_1" } });
    enqueue({ data: { id: "line_1" } });

    const result = await xTwitterAdsProvider.createCampaign(
      { accessToken: "user-token", refreshToken: "token-secret" },
      "18ce54d4x5t",
      {
        organizationId: "org",
        adAccountId: "local-account",
        name: "Launch campaign",
        objective: "traffic",
        budgetType: "daily",
        budgetAmount: 42,
      },
    );

    expect(result).toEqual({
      success: true,
      externalCampaignId: "18ce54d4x5t/camp_1/line_1",
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/12/accounts/18ce54d4x5t/funding_instruments",
      "/12/accounts/18ce54d4x5t/campaigns",
      "/12/accounts/18ce54d4x5t/line_items",
    ]);
    expect(query(calls[1] as FetchCall).get("funding_instrument_id")).toBe("fund_1");
    expect(query(calls[1] as FetchCall).get("entity_status")).toBe("PAUSED");
    expect(query(calls[1] as FetchCall).get("daily_budget_amount_local_micro")).toBe("42000000");
    expect(query(calls[2] as FetchCall).get("objective")).toBe("WEBSITE_CLICKS");
    expect(query(calls[2] as FetchCall).get("product_type")).toBe("PROMOTED_TWEETS");
  });

  test("creates a Tweet and associates it as a promoted tweet", async () => {
    enqueue({ data: { id_str: "tweet_1" } });
    enqueue({ data: [{ id: "promoted_1" }] });
    const media = [
      {
        id: "00000000-0000-4000-8000-000000000002",
        source: "upload" as const,
        url: "https://cdn.example.com/ad-second.png",
        providerAssetId: "4_media",
        type: "image" as const,
        order: 1,
      },
      {
        id: "00000000-0000-4000-8000-000000000001",
        source: "upload" as const,
        url: "https://cdn.example.com/ad-first.png",
        providerAssetId: "3_media",
        type: "image" as const,
        order: 0,
      },
    ];

    const result = await xTwitterAdsProvider.createCreative(
      { accessToken: "user-token", refreshToken: "token-secret" },
      "18ce54d4x5t",
      "18ce54d4x5t/camp_1/line_1",
      {
        campaignId: "campaign-local",
        name: "Creative",
        type: "image",
        headline: "Try it",
        primaryText: "Build faster",
        pageId: "user_1",
        media,
      },
    );

    expect(result).toEqual({ success: true, externalCreativeId: "tweet_1/promoted_1" });
    expect(media.map((item) => item.providerAssetId)).toEqual(["4_media", "3_media"]);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/12/accounts/18ce54d4x5t/tweet",
      "/12/accounts/18ce54d4x5t/promoted_tweets",
    ]);
    expect(query(calls[0] as FetchCall).get("as_user_id")).toBe("user_1");
    expect(query(calls[0] as FetchCall).get("media_keys")).toBe("3_media,4_media");
    expect(query(calls[1] as FetchCall).get("line_item_id")).toBe("line_1");
    expect(query(calls[1] as FetchCall).get("tweet_ids")).toBe("tweet_1");
  });

  test("pauses and activates campaign and line item status", async () => {
    enqueue({ data: { id: "line_1" } });
    enqueue({ data: { id: "camp_1" } });
    enqueue({ data: { id: "camp_1" } });
    enqueue({ data: { id: "line_1" } });

    await expect(
      xTwitterAdsProvider.pauseCampaign(
        { accessToken: "user-token", refreshToken: "token-secret" },
        "18ce54d4x5t/camp_1/line_1",
      ),
    ).resolves.toMatchObject({ success: true });
    await expect(
      xTwitterAdsProvider.activateCampaign(
        { accessToken: "user-token", refreshToken: "token-secret" },
        "18ce54d4x5t/camp_1/line_1",
      ),
    ).resolves.toMatchObject({ success: true });

    expect(query(calls[0] as FetchCall).get("entity_status")).toBe("PAUSED");
    expect(query(calls[1] as FetchCall).get("entity_status")).toBe("PAUSED");
    expect(query(calls[2] as FetchCall).get("entity_status")).toBe("ACTIVE");
    expect(query(calls[3] as FetchCall).get("entity_status")).toBe("ACTIVE");
  });

  test("updates and deletes campaign and line item resources", async () => {
    enqueue({ data: { id: "camp_1" } });
    enqueue({ data: { id: "line_1" } });
    enqueue({ data: { id: "line_1" } });
    enqueue({ data: { id: "camp_1" } });

    await expect(
      xTwitterAdsProvider.updateCampaign(
        { accessToken: "user-token", refreshToken: "token-secret" },
        "18ce54d4x5t/camp_1/line_1",
        {
          name: "Renamed",
          budgetAmount: 25,
          endDate: new Date("2026-07-10T00:00:00Z"),
        },
      ),
    ).resolves.toMatchObject({ success: true });
    await expect(
      xTwitterAdsProvider.deleteCampaign(
        { accessToken: "user-token", refreshToken: "token-secret" },
        "18ce54d4x5t/camp_1/line_1",
      ),
    ).resolves.toMatchObject({ success: true });

    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/12/accounts/18ce54d4x5t/campaigns/camp_1");
    expect(query(calls[0] as FetchCall).get("name")).toBe("Renamed");
    expect(query(calls[0] as FetchCall).get("daily_budget_amount_local_micro")).toBe("25000000");
    expect(query(calls[0] as FetchCall).get("end_time")).toBe("2026-07-10T00:00:00Z");
    expect(new URL(calls[1]?.url ?? "").pathname).toBe(
      "/12/accounts/18ce54d4x5t/line_items/line_1",
    );
    expect(query(calls[1] as FetchCall).get("daily_budget_amount_local_micro")).toBe("25000000");
    expect(calls[2]?.init?.method).toBe("DELETE");
    expect(new URL(calls[2]?.url ?? "").pathname).toBe(
      "/12/accounts/18ce54d4x5t/line_items/line_1",
    );
    expect(calls[3]?.init?.method).toBe("DELETE");
    expect(new URL(calls[3]?.url ?? "").pathname).toBe("/12/accounts/18ce54d4x5t/campaigns/camp_1");
  });

  test("updates a campaign from a two-part account/campaign id", async () => {
    enqueue({ data: { id: "camp_1" } });

    await expect(
      xTwitterAdsProvider.updateCampaign(
        { accessToken: "user-token", refreshToken: "token-secret" },
        "18ce54d4x5t/camp_1",
        { name: "Renamed" },
      ),
    ).resolves.toMatchObject({ success: true });

    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/12/accounts/18ce54d4x5t/campaigns/camp_1");
    expect(query(calls[0] as FetchCall).get("name")).toBe("Renamed");
  });

  test("maps media status and rejects unsafe media upload URLs", async () => {
    enqueue({ data: { media_key: "3_media", media_status: "TRANSCODE_COMPLETED" } });

    await expect(
      xTwitterAdsProvider.getMediaStatus?.(
        { accessToken: "user-token", refreshToken: "token-secret" },
        "18ce54d4x5t",
        { providerAssetResourceName: "3_media" },
      ),
    ).resolves.toMatchObject({
      success: true,
      providerAssetId: "3_media",
      providerAssetResourceName: "3_media",
      status: "TRANSCODE_COMPLETED",
      ready: true,
    });

    await expect(
      xTwitterAdsProvider.uploadMedia?.(
        { accessToken: "user-token", refreshToken: "token-secret" },
        "18ce54d4x5t",
        {
          type: "image",
          url: "http://127.0.0.1/ad.png",
        },
      ),
    ).resolves.toMatchObject({
      success: false,
      error: "Private or reserved IP addresses are not allowed",
    });
  });

  test("maps line item stats into campaign metrics", async () => {
    enqueue({
      data: [
        {
          id: "line_1",
          id_data: [
            {
              metrics: {
                billed_charge_local_micro: [1_500_000, 500_000],
                impressions: [100, 300],
                clicks: [4, 6],
                conversion_purchases: [1, null],
              },
            },
          ],
        },
      ],
    });

    const result = await xTwitterAdsProvider.getCampaignMetrics(
      { accessToken: "user-token", refreshToken: "token-secret" },
      "18ce54d4x5t/camp_1/line_1",
      {
        start: new Date("2026-07-01T00:00:00Z"),
        end: new Date("2026-07-02T00:00:00Z"),
      },
    );

    expect(result).toEqual({
      success: true,
      metrics: {
        spend: 2,
        impressions: 400,
        clicks: 10,
        conversions: 1,
        ctr: 0.025,
        cpc: 0.2,
        cpm: 5,
      },
    });
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/12/stats/accounts/18ce54d4x5t");
    expect(query(calls[0] as FetchCall).get("entity")).toBe("LINE_ITEM");
    expect(query(calls[0] as FetchCall).get("entity_ids")).toBe("line_1");
    expect(query(calls[0] as FetchCall).get("metric_groups")).toBe(
      "ENGAGEMENT,BILLING,WEB_CONVERSION",
    );
  });

  test("does not query stats without a line-item id", async () => {
    const result = await xTwitterAdsProvider.getCampaignMetrics(
      { accessToken: "user-token", refreshToken: "token-secret" },
      "18ce54d4x5t/camp_1",
      {
        start: new Date("2026-07-01T00:00:00Z"),
        end: new Date("2026-07-02T00:00:00Z"),
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: "X Ads metrics require a composite account/campaign/line-item id",
    });
    expect(calls).toEqual([]);
  });
});
