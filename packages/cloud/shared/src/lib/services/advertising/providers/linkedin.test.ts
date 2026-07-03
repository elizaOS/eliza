import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  adAccountsRepository,
  adCampaignsRepository,
  adTransactionsRepository,
} from "../../../../db/repositories";
import { advertisingService } from "../index";
import type { CreateCampaignInput } from "../types";
import { linkedinAdsProvider, mapBidControlsToLinkedInCampaign } from "./linkedin";

const originalFetch = globalThis.fetch;

type FetchCall = {
  url: string;
  init?: RequestInit;
};

const calls: FetchCall[] = [];
let queue: Array<{ status?: number; body: unknown; headers?: Record<string, string> }> = [];

function enqueue(
  body: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
) {
  queue.push({ body, status: options.status ?? 200, headers: options.headers });
}

function requestBody(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

function requestHeaders(call: FetchCall): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>;
}

const credentials = { accessToken: "linkedin-token" };

// Fixtures below are lifted from the LinkedIn Marketing API reference:
// https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-accounts
// https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns
// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
// https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting
const ACCOUNT_SEARCH_FIXTURE = {
  elements: [
    {
      test: false,
      currency: "USD",
      id: 507404993,
      name: "Dunder Mifflin Account",
      reference: "urn:li:organization:2414183",
      servingStatuses: ["BILLING_HOLD"],
      status: "ACTIVE",
      type: "BUSINESS",
    },
  ],
  metadata: { nextPageToken: "DgGerr1iVQreCJVjZDOW_grcp63nueBDipsS4DJpvJo" },
};

const AD_ACCOUNT_FIXTURE = {
  test: false,
  currency: "USD",
  id: 507404993,
  name: "Dunder Mifflin Account",
  reference: "urn:li:organization:2414183",
  servingStatuses: ["RUNNABLE"],
  status: "ACTIVE",
  type: "BUSINESS",
};

const IMAGE_GET_FIXTURE = {
  owner: "urn:li:organization:5583111",
  downloadUrl:
    "https://media.licdn-ei.com/dms/image/C4E10AQFn10iWtKexVA/image-shrink_1280/0/1675963270302/imagecreatedfirst?e=1676584800&v=beta&t=zuE2bQG5S-pY2R1v-FNJu15Pbs2K_Z02Q4naeM2kh00",
  id: "urn:li:image:C4E10AQFn10iWtKexVA",
  downloadUrlExpiresAt: 1679083200000,
  status: "AVAILABLE",
};

const ANALYTICS_FIXTURE = {
  elements: [
    {
      pivotValues: ["urn:li:sponsoredCampaign:145282384"],
      dateRange: {
        start: { month: 5, year: 2024, day: 28 },
        end: { month: 5, year: 2024, day: 28 },
      },
      landingPageClicks: 0,
      costInLocalCurrency: "0.0",
      impressions: 6,
      shares: 0,
      externalWebsiteConversions: 0,
      reactions: 0,
    },
    {
      pivotValues: ["urn:li:sponsoredCampaign:145282384"],
      dateRange: {
        start: { month: 5, year: 2024, day: 29 },
        end: { month: 5, year: 2024, day: 29 },
      },
      landingPageClicks: 11,
      costInLocalCurrency: "19.91833",
      impressions: 165,
      shares: 0,
      externalWebsiteConversions: 0,
      reactions: 0,
    },
  ],
  paging: { count: 10, links: [], start: 0 },
};

function makeCreateInput(over: Partial<CreateCampaignInput> = {}): CreateCampaignInput {
  return {
    organizationId: "00000000-0000-4000-8000-000000000001",
    adAccountId: "00000000-0000-4000-8000-000000000002",
    name: "Launch campaign",
    objective: "traffic",
    budgetType: "daily",
    budgetAmount: 42,
    budgetCurrency: "USD",
    ...over,
  };
}

beforeEach(() => {
  calls.length = 0;
  queue = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift() ?? { body: {}, status: 200 };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json", ...next.headers },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("linkedinAdsProvider", () => {
  test("discovers active LinkedIn ad accounts with versioned Rest.li headers", async () => {
    enqueue(ACCOUNT_SEARCH_FIXTURE);

    const accounts = await linkedinAdsProvider.listAdAccounts(credentials);

    expect(accounts).toEqual([{ id: "507404993", name: "Dunder Mifflin Account" }]);
    expect(calls[0]?.url).toBe(
      "https://api.linkedin.com/rest/adAccounts?q=search&search=(status:(values:List(ACTIVE)))&pageSize=1000",
    );
    const headers = requestHeaders(calls[0] as FetchCall);
    expect(headers.Authorization).toBe("Bearer linkedin-token");
    expect(headers["LinkedIn-Version"]).toBe(process.env.LINKEDIN_ADS_API_VERSION ?? "202606");
    expect(headers["X-Restli-Protocol-Version"]).toBe("2.0.0");
  });

  test("validates credentials through account discovery", async () => {
    enqueue(ACCOUNT_SEARCH_FIXTURE);
    await expect(linkedinAdsProvider.validateCredentials(credentials)).resolves.toEqual({
      valid: true,
      accountId: "507404993",
      accountName: "Dunder Mifflin Account",
    });

    enqueue({ elements: [] });
    await expect(linkedinAdsProvider.validateCredentials(credentials)).resolves.toEqual({
      valid: false,
      error: "No LinkedIn ad accounts found or invalid credentials",
    });
  });

  test("creates a paused campaign under a new campaign group with mapped objective, budget, and auto-bid", async () => {
    enqueue({}, { status: 201, headers: { "x-restli-id": "603407684" } });
    enqueue({}, { status: 201, headers: { "x-restli-id": "145282384" } });

    const result = await linkedinAdsProvider.createCampaign(
      credentials,
      "507404993",
      makeCreateInput({ startDate: new Date("2026-07-01T00:00:00Z") }),
    );

    expect(result).toEqual({
      success: true,
      externalCampaignId: "507404993/603407684/145282384",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.linkedin.com/rest/adAccounts/507404993/adCampaignGroups",
      "https://api.linkedin.com/rest/adAccounts/507404993/adCampaigns",
    ]);

    const groupBody = requestBody(calls[0] as FetchCall);
    expect(groupBody).toMatchObject({
      account: "urn:li:sponsoredAccount:507404993",
      name: "Launch campaign Group",
      status: "ACTIVE",
      runSchedule: { start: Date.parse("2026-07-01T00:00:00Z") },
    });

    const campaignBody = requestBody(calls[1] as FetchCall);
    expect(campaignBody).toMatchObject({
      account: "urn:li:sponsoredAccount:507404993",
      campaignGroup: "urn:li:sponsoredCampaignGroup:603407684",
      name: "Launch campaign",
      type: "SPONSORED_UPDATES",
      objectiveType: "WEBSITE_VISIT",
      costType: "CPC",
      optimizationTargetType: "MAX_CLICK",
      dailyBudget: { amount: "42.00", currencyCode: "USD" },
      status: "PAUSED",
      targetingCriteria: {
        include: {
          and: [{ or: { "urn:li:adTargetingFacet:locations": ["urn:li:geo:92000000"] } }],
        },
      },
    });
    expect(campaignBody.unitCost).toBeUndefined();
  });

  test("maps bid controls onto LinkedIn costType and optimizationTargetType", () => {
    expect(mapBidControlsToLinkedInCampaign({ objective: "traffic", bidStrategy: "cpm" })).toEqual({
      costType: "CPM",
      optimizationTargetType: "MAX_CLICK",
    });
    expect(mapBidControlsToLinkedInCampaign({ objective: "traffic", bidStrategy: "cpc" })).toEqual({
      costType: "CPC",
      optimizationTargetType: "MAX_CLICK",
    });
    expect(
      mapBidControlsToLinkedInCampaign({ objective: "conversions", bidStrategy: "cpa" }),
    ).toEqual({
      costType: "CPM",
      optimizationTargetType: "MAX_CONVERSION",
    });
    expect(
      mapBidControlsToLinkedInCampaign({ objective: "traffic", optimizationGoal: "reach" }),
    ).toEqual({
      costType: "CPC",
      optimizationTargetType: "MAX_IMPRESSION",
    });
    expect(mapBidControlsToLinkedInCampaign({ objective: "awareness" })).toEqual({
      costType: "CPM",
      optimizationTargetType: "MAX_IMPRESSION",
    });
    expect(mapBidControlsToLinkedInCampaign({ objective: "leads" })).toEqual({
      costType: "CPC",
      optimizationTargetType: "MAX_LEAD",
    });
  });

  test("uses a lifetime total budget and requires an end date for it", async () => {
    const noEnd = await linkedinAdsProvider.createCampaign(
      credentials,
      "507404993",
      makeCreateInput({ budgetType: "lifetime" }),
    );
    expect(noEnd.success).toBe(false);
    expect(noEnd.error).toContain("end date");
    expect(calls.length).toBe(0);

    enqueue({}, { status: 201, headers: { "x-restli-id": "603407684" } });
    enqueue({}, { status: 201, headers: { "x-restli-id": "145282384" } });
    const result = await linkedinAdsProvider.createCampaign(
      credentials,
      "507404993",
      makeCreateInput({
        budgetType: "lifetime",
        startDate: new Date("2026-07-01T00:00:00Z"),
        endDate: new Date("2026-08-01T00:00:00Z"),
      }),
    );
    expect(result.success).toBe(true);
    expect(requestBody(calls[0] as FetchCall)).toMatchObject({
      totalBudget: { amount: "42.00", currencyCode: "USD" },
      runSchedule: {
        start: Date.parse("2026-07-01T00:00:00Z"),
        end: Date.parse("2026-08-01T00:00:00Z"),
      },
    });
    expect(requestBody(calls[1] as FetchCall)).toMatchObject({
      totalBudget: { amount: "42.00", currencyCode: "USD" },
    });
    expect(requestBody(calls[1] as FetchCall).dailyBudget).toBeUndefined();
  });

  test("rejects non-geo location targeting before touching the platform", async () => {
    const result = await linkedinAdsProvider.createCampaign(
      credentials,
      "507404993",
      makeCreateInput({ targeting: { locations: ["San Francisco"] } }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("urn:li:geo");
    expect(calls.length).toBe(0);

    enqueue({}, { status: 201, headers: { "x-restli-id": "603407684" } });
    enqueue({}, { status: 201, headers: { "x-restli-id": "145282384" } });
    const geoResult = await linkedinAdsProvider.createCampaign(
      credentials,
      "507404993",
      makeCreateInput({ targeting: { locations: ["urn:li:geo:103644278", "101174742"] } }),
    );
    expect(geoResult.success).toBe(true);
    expect(requestBody(calls[1] as FetchCall).targetingCriteria).toEqual({
      include: {
        and: [
          {
            or: {
              "urn:li:adTargetingFacet:locations": ["urn:li:geo:103644278", "urn:li:geo:101174742"],
            },
          },
        ],
      },
    });
  });

  test("pauses, activates, and deletes campaigns via Rest.li partial updates", async () => {
    enqueue({}, { status: 204 });
    await expect(
      linkedinAdsProvider.pauseCampaign(credentials, "507404993/603407684/145282384"),
    ).resolves.toMatchObject({ success: true });

    enqueue({}, { status: 204 });
    await expect(
      linkedinAdsProvider.activateCampaign(credentials, "507404993/603407684/145282384"),
    ).resolves.toMatchObject({ success: true });

    enqueue({}, { status: 204 });
    enqueue({}, { status: 204 });
    await expect(
      linkedinAdsProvider.deleteCampaign(credentials, "507404993/603407684/145282384"),
    ).resolves.toEqual({ success: true });

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.linkedin.com/rest/adAccounts/507404993/adCampaigns/145282384",
      "https://api.linkedin.com/rest/adAccounts/507404993/adCampaigns/145282384",
      "https://api.linkedin.com/rest/adAccounts/507404993/adCampaigns/145282384",
      "https://api.linkedin.com/rest/adAccounts/507404993/adCampaignGroups/603407684",
    ]);
    expect(requestBody(calls[0] as FetchCall)).toEqual({ patch: { $set: { status: "PAUSED" } } });
    expect(requestBody(calls[1] as FetchCall)).toEqual({ patch: { $set: { status: "ACTIVE" } } });
    expect(requestBody(calls[2] as FetchCall)).toEqual({
      patch: { $set: { status: "PENDING_DELETION" } },
    });
    expect(requestBody(calls[3] as FetchCall)).toEqual({
      patch: { $set: { status: "PENDING_DELETION" } },
    });
    for (const call of calls) {
      expect(requestHeaders(call)["X-RestLi-Method"]).toBe("PARTIAL_UPDATE");
    }
  });

  test("updates the budget field the live campaign actually uses", async () => {
    enqueue({ id: 145282384, dailyBudget: { amount: "18", currencyCode: "USD" } });
    enqueue({}, { status: 204 });

    const result = await linkedinAdsProvider.updateCampaign(
      credentials,
      "507404993/603407684/145282384",
      { name: "Renamed", budgetAmount: 30 },
    );

    expect(result).toEqual({
      success: true,
      externalCampaignId: "507404993/603407684/145282384",
    });
    expect(calls[0]?.init?.method ?? "GET").toBe("GET");
    expect(requestBody(calls[1] as FetchCall)).toEqual({
      patch: {
        $set: {
          name: "Renamed",
          dailyBudget: { amount: "30.00", currencyCode: "USD" },
        },
      },
    });
  });

  test("creates an inline dark-post creative attributed to the account's organization", async () => {
    enqueue(AD_ACCOUNT_FIXTURE);
    enqueue({}, { status: 201, headers: { "x-restli-id": "urn:li:sponsoredCreative:120491345" } });

    const result = await linkedinAdsProvider.createCreative(
      credentials,
      "507404993",
      "507404993/603407684/145282384",
      {
        campaignId: "campaign-local",
        name: "Creative",
        type: "image",
        headline: "Try it",
        primaryText: "Build faster",
        callToAction: "download",
        destinationUrl: "https://example.test/landing",
        media: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            source: "upload",
            url: "https://cdn.example.com/ad.png",
            providerAssetId: "urn:li:image:C4E10AQFn10iWtKexVA",
            type: "image",
            order: 0,
          },
        ],
      },
    );

    expect(result).toEqual({
      success: true,
      externalCreativeId: "urn:li:sponsoredCreative:120491345",
    });
    expect(calls[0]?.url).toBe("https://api.linkedin.com/rest/adAccounts/507404993");
    expect(calls[1]?.url).toBe(
      "https://api.linkedin.com/rest/adAccounts/507404993/creatives?action=createInline",
    );
    expect(requestBody(calls[1] as FetchCall)).toEqual({
      creative: {
        inlineContent: {
          post: {
            adContext: {
              dscAdAccount: "urn:li:sponsoredAccount:507404993",
              dscStatus: "ACTIVE",
            },
            author: "urn:li:organization:2414183",
            commentary: "Build faster",
            visibility: "PUBLIC",
            lifecycleState: "PUBLISHED",
            isReshareDisabledByAuthor: true,
            contentCallToActionLabel: "DOWNLOAD",
            contentLandingPage: "https://example.test/landing",
            content: {
              media: {
                title: "Try it",
                id: "urn:li:image:C4E10AQFn10iWtKexVA",
              },
            },
          },
        },
        campaign: "urn:li:sponsoredCampaign:145282384",
        intendedStatus: "ACTIVE",
        name: "Creative",
      },
    });
  });

  test("requires an uploaded provider asset before creating a creative", async () => {
    const result = await linkedinAdsProvider.createCreative(
      credentials,
      "507404993",
      "507404993/603407684/145282384",
      {
        campaignId: "campaign-local",
        name: "Creative",
        type: "image",
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
    expect(result.success).toBe(false);
    expect(result.error).toContain("providerAssetId");
    expect(calls.length).toBe(0);
  });

  test("reads media processing status from the images API", async () => {
    enqueue(IMAGE_GET_FIXTURE);

    const status = await linkedinAdsProvider.getMediaStatus?.(credentials, "507404993", {
      providerAssetResourceName: "urn:li:image:C4E10AQFn10iWtKexVA",
    });

    expect(calls[0]?.url).toBe(
      "https://api.linkedin.com/rest/images/urn%3Ali%3Aimage%3AC4E10AQFn10iWtKexVA",
    );
    expect(status).toMatchObject({
      success: true,
      status: "AVAILABLE",
      ready: true,
      providerAssetId: "urn:li:image:C4E10AQFn10iWtKexVA",
    });
  });

  test("sums adAnalytics rows into campaign metrics", async () => {
    enqueue(ANALYTICS_FIXTURE);

    const result = await linkedinAdsProvider.getCampaignMetrics(
      credentials,
      "507404993/603407684/145282384",
      {
        start: new Date("2024-05-28T00:00:00Z"),
        end: new Date("2024-05-29T00:00:00Z"),
      },
    );

    expect(calls[0]?.url).toBe(
      "https://api.linkedin.com/rest/adAnalytics?q=analytics&pivot=CAMPAIGN&timeGranularity=ALL" +
        "&dateRange=(start:(year:2024,month:5,day:28),end:(year:2024,month:5,day:29))" +
        "&campaigns=List(urn%3Ali%3AsponsoredCampaign%3A145282384)" +
        "&fields=impressions,clicks,landingPageClicks,costInLocalCurrency,externalWebsiteConversions,oneClickLeads,pivotValues",
    );
    expect(result.success).toBe(true);
    expect(result.metrics?.spend).toBeCloseTo(19.91833, 5);
    expect(result.metrics?.impressions).toBe(171);
    expect(result.metrics?.clicks).toBe(11);
    expect(result.metrics?.conversions).toBe(0);
    expect(result.metrics?.ctr).toBeCloseTo(11 / 171, 6);
    expect(result.metrics?.cpc).toBeCloseTo(19.91833 / 11, 5);
    expect(result.metrics?.cpm).toBeCloseTo((19.91833 / 171) * 1000, 4);
  });

  test("propagates LinkedIn API errors as failed results without partial success", async () => {
    enqueue(
      { message: "Not enough permissions to access: adCampaignGroups.CREATE", status: 403 },
      { status: 403 },
    );

    const result = await linkedinAdsProvider.createCampaign(
      credentials,
      "507404993",
      makeCreateInput(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Not enough permissions");
    expect(calls.length).toBe(1);
  });
});

describe("advertisingService with the LinkedIn provider", () => {
  const ORG_ID = "00000000-0000-4000-8000-000000000001";
  const ACCOUNT_ID = "00000000-0000-4000-8000-000000000002";

  const spies: Array<{ mockRestore: () => void }> = [];
  function track<T extends { mockRestore: () => void }>(s: T): T {
    spies.push(s);
    return s;
  }

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  test("account approval gate (#11619) blocks LinkedIn campaign creation before any charge or API call", async () => {
    track(
      spyOn(adAccountsRepository, "findById").mockResolvedValue({
        id: ACCOUNT_ID,
        organization_id: ORG_ID,
        platform: "linkedin",
        external_account_id: "507404993",
        status: "pending",
      } as never),
    );
    const { contentSafetyService } = await import("../../content-safety");
    const { creditsService } = await import("../../credits");
    const safety = track(spyOn(contentSafetyService, "assertSafeForPublicUse"));
    const deduct = track(spyOn(creditsService, "deductCredits"));

    await expect(
      advertisingService.createCampaign({
        organizationId: ORG_ID,
        adAccountId: ACCOUNT_ID,
        name: "LinkedIn launch",
        objective: "traffic",
        budgetType: "daily",
        budgetAmount: 50,
      }),
    ).rejects.toThrow(/must be approved/);

    expect(safety).not.toHaveBeenCalled();
    expect(deduct).not.toHaveBeenCalled();
    expect(calls.length).toBe(0);
  });

  test("bid controls (#11621) persist in metadata and reach the real LinkedIn provider payload", async () => {
    track(
      spyOn(adAccountsRepository, "findById").mockResolvedValue({
        id: ACCOUNT_ID,
        organization_id: ORG_ID,
        platform: "linkedin",
        external_account_id: "507404993",
        status: "active",
      } as never),
    );
    const { contentSafetyService } = await import("../../content-safety");
    const { creditsService } = await import("../../credits");
    track(spyOn(contentSafetyService, "assertSafeForPublicUse").mockResolvedValue({} as never));
    track(
      spyOn(creditsService, "deductCredits").mockResolvedValue({
        success: true,
        transaction: { id: "tx-1" },
      } as never),
    );
    track(
      spyOn(
        advertisingService as unknown as { getCredentials: () => Promise<unknown> },
        "getCredentials",
      ).mockResolvedValue({ accessToken: "linkedin-token" } as never),
    );
    const createRow = track(
      spyOn(adCampaignsRepository, "create").mockImplementation(
        async (data) => ({ ...(data as Record<string, unknown>), id: "campaign-row-1" }) as never,
      ),
    );
    track(spyOn(adTransactionsRepository, "create").mockResolvedValue({} as never));

    enqueue({}, { status: 201, headers: { "x-restli-id": "603407684" } });
    enqueue({}, { status: 201, headers: { "x-restli-id": "145282384" } });

    const campaign = await advertisingService.createCampaign({
      organizationId: ORG_ID,
      adAccountId: ACCOUNT_ID,
      name: "LinkedIn launch",
      objective: "traffic",
      budgetType: "daily",
      budgetAmount: 50,
      bidStrategy: "cpc",
      optimizationGoal: "clicks",
    });

    expect(createRow.mock.calls[0]?.[0]).toMatchObject({
      platform: "linkedin",
      external_campaign_id: "507404993/603407684/145282384",
      metadata: {
        bid_strategy: "cpc",
        optimization_goal: "clicks",
      },
    });
    expect(campaign).toMatchObject({ external_campaign_id: "507404993/603407684/145282384" });

    // The real provider request carried the mapped bid controls.
    const campaignCall = calls.find((call) => call.url.endsWith("/adCampaigns"));
    expect(campaignCall).toBeDefined();
    expect(requestBody(campaignCall as FetchCall)).toMatchObject({
      costType: "CPC",
      optimizationTargetType: "MAX_CLICK",
    });
  });

  test("provider failure fails the service call closed and refunds all charged credits", async () => {
    track(
      spyOn(adAccountsRepository, "findById").mockResolvedValue({
        id: ACCOUNT_ID,
        organization_id: ORG_ID,
        platform: "linkedin",
        external_account_id: "507404993",
        status: "active",
      } as never),
    );
    const { contentSafetyService } = await import("../../content-safety");
    const { creditsService } = await import("../../credits");
    track(spyOn(contentSafetyService, "assertSafeForPublicUse").mockResolvedValue({} as never));
    track(
      spyOn(creditsService, "deductCredits").mockResolvedValue({
        success: true,
        transaction: { id: "tx-1" },
      } as never),
    );
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({ success: true } as never),
    );
    track(
      spyOn(
        advertisingService as unknown as { getCredentials: () => Promise<unknown> },
        "getCredentials",
      ).mockResolvedValue({ accessToken: "linkedin-token" } as never),
    );
    const createRow = track(spyOn(adCampaignsRepository, "create"));

    enqueue(
      { message: "Not enough permissions to access: adCampaignGroups.CREATE", status: 403 },
      { status: 403 },
    );

    await expect(
      advertisingService.createCampaign({
        organizationId: ORG_ID,
        adAccountId: ACCOUNT_ID,
        name: "LinkedIn launch",
        objective: "traffic",
        budgetType: "daily",
        budgetAmount: 50,
      }),
    ).rejects.toThrow(/Not enough permissions/);

    expect(createRow).not.toHaveBeenCalled();
    // createCampaign charge + budget allocation are both refunded in one call.
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund.mock.calls[0]?.[0]).toMatchObject({
      organizationId: ORG_ID,
      amount: 0.5 + 50 * 1.1,
    });
  });
});
