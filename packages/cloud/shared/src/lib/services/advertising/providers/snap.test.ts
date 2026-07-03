import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { snapAdsProvider } from "./snap";

vi.mock("../media-utils", () => ({
  downloadAdMedia: vi.fn(async (url: string) => ({
    url,
    bytes: new Uint8Array([1, 2, 3]),
    base64: "AQID",
    contentType: "image/png",
    fileName: "asset.png",
  })),
  mediaFileName: vi.fn(() => "asset.png"),
}));

const credentials = { accessToken: "snap-token" };
const originalFetch = globalThis.fetch;

function fetchMock() {
  return fetch as unknown as ReturnType<typeof vi.fn>;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    ...init,
    status: init.status ?? 200,
    headers,
  });
}

function success(body: Record<string, unknown> = {}) {
  return jsonResponse({ request_status: "SUCCESS", ...body });
}

function nextRequest(index: number) {
  const mock = fetchMock();
  const init = mock.mock.calls[index][1] as RequestInit;
  const body = init.body instanceof FormData ? init.body : JSON.parse(String(init.body ?? "{}"));
  return {
    url: new URL(mock.mock.calls[index][0] as string),
    init,
    body,
  };
}

describe("snapAdsProvider", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("lists ad accounts from organizations with embedded ad accounts", async () => {
    fetchMock().mockResolvedValueOnce(
      success({
        organizations: [
          {
            organization: {
              id: "org-1",
              name: "Org",
              ad_accounts: [
                { id: "act-1", name: "Snap Account", status: "ACTIVE" },
                { id: "act-2", status: "ACTIVE" },
              ],
            },
          },
        ],
      }),
    );

    await expect(snapAdsProvider.listAdAccounts(credentials)).resolves.toEqual([
      { id: "act-1", name: "Snap Account" },
      { id: "act-2", name: "Snap Ad Account act-2" },
    ]);

    const request = nextRequest(0);
    expect(request.url.pathname).toBe("/v1/me/organizations");
    expect(request.url.searchParams.get("with_ad_accounts")).toBe("true");
    expect(request.init.headers).toMatchObject({
      Authorization: "Bearer snap-token",
      "Content-Type": "application/json",
    });
  });

  test("creates a paused campaign and paused ad squad", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        success({
          campaigns: [
            {
              sub_request_status: "SUCCESS",
              campaign: { id: "campaign-1" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        success({
          adsquads: [
            {
              sub_request_status: "SUCCESS",
              adsquad: { id: "squad-1" },
            },
          ],
        }),
      );

    const result = await snapAdsProvider.createCampaign(credentials, "act-1", {
      organizationId: "org-1",
      adAccountId: "ad-row-1",
      name: "Snap launch",
      objective: "traffic",
      budgetType: "daily",
      budgetAmount: 25,
      startDate: new Date("2026-01-02T00:00:00Z"),
      targeting: { locations: ["US", "CA"] },
    });

    expect(result).toEqual({
      success: true,
      externalCampaignId: "act-1/campaign-1/squad-1",
    });

    const campaignCreate = nextRequest(0);
    expect(campaignCreate.url.pathname).toBe("/v1/adaccounts/act-1/campaigns");
    expect(campaignCreate.body).toMatchObject({
      campaigns: [
        {
          ad_account_id: "act-1",
          name: "Snap launch",
          status: "PAUSED",
          buy_model: "AUCTION",
          creation_state: "PUBLISHED",
          objective: "WEB_VIEW",
          objective_v2_properties: { objective_v2_type: "TRAFFIC" },
          daily_budget_micro: 25_000_000,
        },
      ],
    });

    const squadCreate = nextRequest(1);
    expect(squadCreate.url.pathname).toBe("/v1/campaigns/campaign-1/adsquads");
    expect(squadCreate.body).toMatchObject({
      adsquads: [
        {
          campaign_id: "campaign-1",
          name: "Snap launch - Ad Squad",
          type: "SNAP_ADS",
          placement_v2: { config: "AUTOMATIC" },
          optimization_goal: "SWIPES",
          billing_event: "IMPRESSION",
          bid_strategy: "AUTO_BID",
          daily_budget_micro: 25_000_000,
          status: "PAUSED",
          targeting: {
            geos: [{ country_code: "us" }, { country_code: "ca" }],
          },
        },
      ],
    });
  });

  test("patches campaign and ad squad lifecycle state", async () => {
    fetchMock()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success());

    await expect(
      snapAdsProvider.pauseCampaign(credentials, "act-1/campaign-1/squad-1"),
    ).resolves.toEqual({
      success: true,
      externalCampaignId: "act-1/campaign-1/squad-1",
    });
    await snapAdsProvider.activateCampaign(credentials, "act-1/campaign-1/squad-1");

    expect(nextRequest(0).url.pathname).toBe("/v1/adaccounts/act-1/campaigns/campaign-1");
    expect(nextRequest(0).body).toEqual([{ op: "replace", path: "/status", value: "PAUSED" }]);
    expect(nextRequest(1).url.pathname).toBe("/v1/campaigns/campaign-1/adsquads/squad-1");
    expect(nextRequest(1).body).toEqual([{ op: "replace", path: "/status", value: "PAUSED" }]);
    expect(nextRequest(2).body).toEqual([{ op: "replace", path: "/status", value: "ACTIVE" }]);
    expect(nextRequest(3).body).toEqual([{ op: "replace", path: "/status", value: "ACTIVE" }]);
    expect(nextRequest(0).init.headers).toMatchObject({
      "Content-Type": "application/json-patch+json",
    });
  });

  test("uploads media through create media then multipart upload", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        success({
          media: [
            {
              sub_request_status: "SUCCESS",
              media: { id: "media-1", media_status: "PENDING_UPLOAD" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        success({
          result: {
            id: "media-1",
            media_status: "READY",
            type: "IMAGE",
            download_link: "https://storage.snap/asset.png",
          },
        }),
      );

    await expect(
      snapAdsProvider.uploadMedia?.(credentials, "act-1", {
        name: "asset",
        type: "image",
        url: "https://cdn.example.com/asset.png",
        mimeType: "image/png",
      }),
    ).resolves.toMatchObject({
      success: true,
      providerAssetId: "media-1",
      providerAssetResourceName: "media-1",
      providerAssetUrl: "https://storage.snap/asset.png",
      metadata: { mediaStatus: "READY", mediaType: "IMAGE" },
    });

    const createMedia = nextRequest(0);
    expect(createMedia.url.pathname).toBe("/v1/adaccounts/act-1/media");
    expect(createMedia.body).toEqual({
      media: [{ name: "asset.png", type: "IMAGE", ad_account_id: "act-1" }],
    });

    const upload = nextRequest(1);
    expect(upload.url.pathname).toBe("/v1/media/media-1/upload");
    expect(upload.body).toBeInstanceOf(FormData);
    expect(upload.init.headers).toMatchObject({
      Authorization: "Bearer snap-token",
    });
    expect(upload.init.headers).not.toMatchObject({
      "Content-Type": "application/json",
    });
  });

  test("creates a web view creative and paused ad", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        success({
          creatives: [
            {
              sub_request_status: "SUCCESS",
              creative: { id: "creative-1" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        success({
          ads: [
            {
              sub_request_status: "SUCCESS",
              ad: { id: "ad-1" },
            },
          ],
        }),
      );

    await expect(
      snapAdsProvider.createCreative(credentials, "act-1", "act-1/campaign-1/squad-1", {
        campaignId: "campaign-row-1",
        name: "Creative one",
        type: "image",
        headline: "Meet elizaOS",
        description: "elizaOS",
        destinationUrl: "https://elizaos.ai",
        callToAction: "learn_more",
        media: [
          {
            id: "media-row-1",
            source: "upload",
            url: "https://cdn.example.com/asset.png",
            providerAssetId: "media-1",
            type: "image",
            order: 0,
          },
        ],
      }),
    ).resolves.toEqual({ success: true, externalCreativeId: "creative-1/ad-1" });

    const creative = nextRequest(0);
    expect(creative.url.pathname).toBe("/v1/adaccounts/act-1/creatives");
    expect(creative.body).toMatchObject({
      creatives: [
        {
          ad_account_id: "act-1",
          top_snap_media_id: "media-1",
          name: "Creative one",
          type: "WEB_VIEW",
          shareable: true,
          call_to_action: "LEARN_MORE",
          headline: "Meet elizaOS",
          brand_name: "elizaOS",
          web_view_properties: {
            url: "https://elizaos.ai",
            block_preload: false,
          },
        },
      ],
    });

    const ad = nextRequest(1);
    expect(ad.url.pathname).toBe("/v1/adsquads/squad-1/ads");
    expect(ad.body).toEqual({
      ads: [
        {
          ad_squad_id: "squad-1",
          creative_id: "creative-1",
          name: "Creative one",
          type: "REMOTE_WEBPAGE",
          status: "PAUSED",
        },
      ],
    });
  });

  test("maps lifetime stats from microcurrency to campaign metrics", async () => {
    fetchMock().mockResolvedValueOnce(
      success({
        lifetime_stats: [
          {
            sub_request_status: "SUCCESS",
            lifetime_stat: {
              stats: {
                spend: 12_500_000,
                paid_impressions: 100,
                swipes: 7,
                conversion_purchases: 2,
                conversion_sign_ups: 1,
              },
            },
          },
        ],
      }),
    );

    await expect(
      snapAdsProvider.getCampaignMetrics(credentials, "act-1/campaign-1/squad-1"),
    ).resolves.toEqual({
      success: true,
      metrics: {
        spend: 12.5,
        impressions: 100,
        clicks: 7,
        conversions: 3,
      },
    });

    const request = nextRequest(0);
    expect(request.url.pathname).toBe("/v1/campaigns/campaign-1/stats");
    expect(request.url.searchParams.get("granularity")).toBe("LIFETIME");
    expect(request.url.searchParams.get("fields")).toBe(
      "paid_impressions,swipes,swipe_ups,spend,conversion_purchases,conversion_sign_ups",
    );
  });
});
