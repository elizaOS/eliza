import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { linkedinAdsProvider } from "./linkedin";

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

const credentials = { accessToken: "linkedin-token" };
const originalFetch = globalThis.fetch;

function fetchMock() {
  return fetch as unknown as ReturnType<typeof vi.fn>;
}

function jsonResponse(body: unknown, init: ResponseInit & { restliId?: string } = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.restliId) headers.set("x-restli-id", init.restliId);
  return new Response(JSON.stringify(body), {
    ...init,
    status: init.status ?? 200,
    headers,
  });
}

function nextRequest(index: number) {
  const mock = fetchMock();
  return {
    url: new URL(mock.mock.calls[index][0] as string),
    init: mock.mock.calls[index][1] as RequestInit,
    body: JSON.parse(String((mock.mock.calls[index][1] as RequestInit).body ?? "{}")),
  };
}

describe("linkedinAdsProvider", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("lists ad accounts with LinkedIn Marketing headers", async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        elements: [{ id: 12345, name: "elizaOS Ads", status: "ACTIVE" }],
      }),
    );

    await expect(linkedinAdsProvider.listAdAccounts(credentials)).resolves.toEqual([
      { id: "12345", name: "elizaOS Ads" },
    ]);

    const request = nextRequest(0);
    expect(request.url.pathname).toBe("/rest/adAccounts");
    expect(request.url.searchParams.get("q")).toBe("search");
    expect(request.init.headers).toMatchObject({
      Authorization: "Bearer linkedin-token",
      "Linkedin-Version": "202606",
      "X-Restli-Protocol-Version": "2.0.0",
    });
  });

  test("creates a paused campaign under an existing campaign group", async () => {
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ elements: [{ id: 77, status: "ACTIVE" }] }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 201, restliId: "888" }));

    const result = await linkedinAdsProvider.createCampaign(credentials, "12345", {
      organizationId: "org-1",
      adAccountId: "ad-account-1",
      name: "Launch campaign",
      objective: "traffic",
      budgetType: "daily",
      budgetAmount: 50,
      budgetCurrency: "USD",
      startDate: new Date("2026-01-02T00:00:00Z"),
    });

    expect(result).toEqual({
      success: true,
      externalCampaignId: "12345/77/888",
    });

    const groupSearch = nextRequest(0);
    expect(groupSearch.url.pathname).toBe("/rest/adAccounts/12345/adCampaignGroups");
    expect(groupSearch.url.searchParams.get("search")).toBe(
      "(status:(values:List(ACTIVE,DRAFT,PAUSED)))",
    );

    const create = nextRequest(1);
    expect(create.url.pathname).toBe("/rest/adAccounts/12345/adCampaigns");
    expect(create.body).toMatchObject({
      account: "urn:li:sponsoredAccount:12345",
      campaignGroup: "urn:li:sponsoredCampaignGroup:77",
      creativeSelection: "OPTIMIZED",
      dailyBudget: { amount: "50.00", currencyCode: "USD" },
      name: "Launch campaign",
      objectiveType: "WEBSITE_VISITS",
      status: "PAUSED",
      type: "TEXT_AD",
    });
  });

  test("creates a paused campaign group when none exists", async () => {
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ elements: [] }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 201, restliId: "77" }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 201, restliId: "888" }));

    await expect(
      linkedinAdsProvider.createCampaign(credentials, "12345", {
        organizationId: "org-1",
        adAccountId: "ad-account-1",
        name: "Launch campaign",
        objective: "awareness",
        budgetType: "lifetime",
        budgetAmount: 500,
      }),
    ).resolves.toEqual({
      success: true,
      externalCampaignId: "12345/77/888",
    });

    const groupCreate = nextRequest(1);
    expect(groupCreate.url.pathname).toBe("/rest/adAccounts/12345/adCampaignGroups");
    expect(groupCreate.body).toMatchObject({
      name: "elizaOS Campaigns",
      status: "PAUSED",
    });

    const campaignCreate = nextRequest(2);
    expect(campaignCreate.body).toMatchObject({
      objectiveType: "BRAND_AWARENESS",
      totalBudget: { amount: "500.00", currencyCode: "USD" },
      status: "PAUSED",
    });
  });

  test("patches lifecycle state through LinkedIn Rest.li partial updates", async () => {
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}));

    await expect(linkedinAdsProvider.pauseCampaign(credentials, "12345/77/888")).resolves.toEqual({
      success: true,
      externalCampaignId: "12345/77/888",
    });
    await linkedinAdsProvider.activateCampaign(credentials, "12345/77/888");
    await linkedinAdsProvider.deleteCampaign(credentials, "12345/77/888");

    expect(nextRequest(0).body).toEqual({ patch: { $set: { status: "PAUSED" } } });
    expect(nextRequest(1).body).toEqual({ patch: { $set: { status: "ACTIVE" } } });
    expect(nextRequest(2).body).toEqual({ patch: { $set: { status: "ARCHIVED" } } });
  });

  test("creates a text ad creative", async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({}, { status: 201, restliId: "999" }));

    await expect(
      linkedinAdsProvider.createCreative(credentials, "12345", "12345/77/888", {
        campaignId: "campaign-row-1",
        name: "Creative one",
        type: "image",
        headline: "Meet elizaOS",
        primaryText: "Build autonomous agents.",
        destinationUrl: "https://elizaos.ai",
        media: [],
      }),
    ).resolves.toEqual({ success: true, externalCreativeId: "999" });

    const request = nextRequest(0);
    expect(request.url.pathname).toBe("/rest/adAccounts/12345/creatives");
    expect(request.body).toEqual({
      campaign: "urn:li:sponsoredCampaign:888",
      name: "Creative one",
      status: "PAUSED",
      type: "TEXT_AD",
      variables: {
        clickUri: "https://elizaos.ai",
        data: {
          "com.linkedin.ads.TextAdCreativeVariables": {
            title: "Meet elizaOS",
            text: "Build autonomous agents.",
          },
        },
      },
    });
  });

  test("uploads image assets into the LinkedIn media library", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        jsonResponse({
          value: {
            uploadUrl: "https://www.linkedin.com/dms-uploads/image",
            image: "urn:li:image:abc",
            uploadUrlExpiresAt: 123,
          },
        }),
      )
      .mockResolvedValueOnce(new Response("", { status: 201 }));

    await expect(
      linkedinAdsProvider.uploadMedia?.(credentials, "12345", {
        name: "asset",
        type: "image",
        url: "https://cdn.example.com/asset.png",
        mimeType: "image/png",
      }),
    ).resolves.toMatchObject({
      success: true,
      providerAssetId: "urn:li:image:abc",
      providerAssetResourceName: "urn:li:image:abc",
    });

    const initialize = nextRequest(0);
    expect(initialize.url.pathname).toBe("/rest/images");
    expect(initialize.url.searchParams.get("action")).toBe("initializeUpload");
    expect(initialize.body).toEqual({
      initializeUploadRequest: {
        owner: "urn:li:sponsoredAccount:12345",
        mediaLibraryMetadata: {
          associatedAccount: "urn:li:sponsoredAccount:12345",
          assetName: "asset.png",
        },
      },
    });

    const upload = fetchMock().mock.calls[1];
    expect(upload[0]).toBe("https://www.linkedin.com/dms-uploads/image");
    expect(upload[1]).toMatchObject({
      method: "PUT",
      headers: {
        Authorization: "Bearer linkedin-token",
        "Content-Type": "image/png",
      },
    });
  });

  test("maps LinkedIn analytics rows into campaign metrics", async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        elements: [
          {
            costInLocalCurrency: "12.50",
            impressions: 100,
            landingPageClicks: 7,
            externalWebsiteConversions: 2,
          },
          {
            costInLocalCurrency: "1.25",
            impressions: 10,
            landingPageClicks: 1,
            externalWebsiteConversions: 0,
          },
        ],
      }),
    );

    await expect(
      linkedinAdsProvider.getCampaignMetrics(credentials, "12345/77/888", {
        start: new Date("2026-01-01T00:00:00Z"),
        end: new Date("2026-01-31T00:00:00Z"),
      }),
    ).resolves.toEqual({
      success: true,
      metrics: {
        spend: 13.75,
        impressions: 110,
        clicks: 8,
        conversions: 2,
      },
    });

    const request = nextRequest(0);
    expect(request.url.pathname).toBe("/rest/adAnalytics");
    expect(request.url.searchParams.get("campaigns")).toBe("List(urn:li:sponsoredCampaign:888)");
    expect(request.url.searchParams.get("dateRange")).toBe(
      "(start:(year:2026,month:1,day:1),end:(year:2026,month:1,day:31))",
    );
  });
});
