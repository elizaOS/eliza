// Exercises programmatic dsp behavior with deterministic cloud-shared lib fixtures.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { programmaticDspProvider } from "./programmatic-dsp";

const originalFetch = globalThis.fetch;
const originalEndpoint = process.env.PROGRAMMATIC_DSP_ENDPOINT;
const originalSeat = process.env.PROGRAMMATIC_DSP_SEAT_ID;

const DSP_ENDPOINT = "https://dsp.example.com/rtb";

type FetchCall = { url: string; init?: RequestInit };

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
  process.env.PROGRAMMATIC_DSP_ENDPOINT = DSP_ENDPOINT;
  process.env.PROGRAMMATIC_DSP_SEAT_ID = "seat_42";
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
  if (originalEndpoint === undefined) delete process.env.PROGRAMMATIC_DSP_ENDPOINT;
  else process.env.PROGRAMMATIC_DSP_ENDPOINT = originalEndpoint;
  if (originalSeat === undefined) delete process.env.PROGRAMMATIC_DSP_SEAT_ID;
  else process.env.PROGRAMMATIC_DSP_SEAT_ID = originalSeat;
});

describe("programmaticDspProvider", () => {
  test("registers as the programmatic-dsp platform", () => {
    expect(programmaticDspProvider.platform).toBe("programmatic-dsp");
  });

  test("discovers DSP advertiser accounts against the configured endpoint with a bearer token", async () => {
    enqueue({
      data: [
        { id: "adv_1", name: "Advertiser One" },
        { id: "adv_2", name: null },
      ],
    });

    const accounts = await programmaticDspProvider.listAdAccounts({ accessToken: "token" });

    expect(accounts).toEqual([
      { id: "adv_1", name: "Advertiser One" },
      { id: "adv_2", name: "adv_2" },
    ]);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe("https://dsp.example.com/rtb/advertisers");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer token",
      "X-OpenRTB-Version": "2.6",
    });
  });

  test("validateCredentials returns the first advertiser when discovery succeeds", async () => {
    enqueue({ data: [{ id: "adv_1", name: "Advertiser One" }] });
    await expect(
      programmaticDspProvider.validateCredentials({ accessToken: "token" }),
    ).resolves.toEqual({ valid: true, accountId: "adv_1", accountName: "Advertiser One" });
  });

  test("validateCredentials fails closed when no advertisers are returned", async () => {
    enqueue({ data: [] });
    await expect(
      programmaticDspProvider.validateCredentials({ accessToken: "token" }),
    ).resolves.toEqual({
      valid: false,
      error: "No DSP advertiser accounts found or invalid credentials",
    });
  });

  test("validateCredentials fails closed when discovery throws", async () => {
    enqueue({ error: { message: "unauthorized" } }, { ok: false, status: 401 });
    await expect(
      programmaticDspProvider.validateCredentials({ accessToken: "bad" }),
    ).resolves.toMatchObject({ valid: false });
  });

  test("creates a paused campaign and OpenRTB line item with mapped budget, pricing, and targeting", async () => {
    enqueue({ data: { id: "cmp_1" } });
    enqueue({ data: { id: "li_1" } });

    const result = await programmaticDspProvider.createCampaign({ accessToken: "token" }, "adv_1", {
      organizationId: "org",
      adAccountId: "local-account",
      name: "Launch Campaign",
      objective: "conversions",
      budgetType: "lifetime",
      budgetAmount: 25,
      budgetCurrency: "EUR",
      bidStrategy: "cpc",
      targeting: {
        locations: ["US", "CA"],
        interests: ["gaming"],
        behaviors: ["indie apps"],
        customAudiences: ["aud_1"],
        excludedAudiences: ["aud_x"],
        placements: ["IAB1"],
        languages: ["en"],
        genders: ["male"],
        ageMin: 18,
        ageMax: 34,
      },
    });

    expect(result).toEqual({ success: true, externalCampaignId: "adv_1/cmp_1/li_1" });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/rtb/advertisers/adv_1/campaigns",
      "/rtb/advertisers/adv_1/line-items",
    ]);
    expect(jsonBody(calls[0] as FetchCall)).toMatchObject({
      name: "Launch Campaign",
      status: "PAUSED",
      objective: "CONVERSIONS",
      budget_type: "LIFETIME",
      budget_micros: 25_000_000,
      currency: "EUR",
    });
    expect(jsonBody(calls[1] as FetchCall)).toMatchObject({
      campaign_id: "cmp_1",
      status: "PAUSED",
      seat: "seat_42",
      pricing_model: "CPC",
      bid_floor_micros: 25_000_000,
      targeting: {
        geo: { country: ["US", "CA"] },
        segment: [{ id: "gaming" }, { id: "indie apps" }, { id: "aud_1" }],
        excluded_segment: [{ id: "aud_x" }],
        sitecat: ["IAB1"],
        language: ["en"],
        gender: "M",
        yob_range: { min_age: 18, max_age: 34 },
      },
    });
  });

  test("defaults budget currency to USD and pricing model to CPM", async () => {
    enqueue({ data: { id: "cmp_1" } });
    enqueue({ data: { id: "li_1" } });
    await programmaticDspProvider.createCampaign({ accessToken: "token" }, "adv_1", {
      organizationId: "org",
      adAccountId: "local-account",
      name: "Awareness",
      objective: "awareness",
      budgetType: "daily",
      budgetAmount: 10,
    });
    expect(jsonBody(calls[0] as FetchCall)).toMatchObject({
      objective: "IMPRESSIONS",
      budget_type: "DAILY",
      currency: "USD",
    });
    expect(jsonBody(calls[1] as FetchCall)).toMatchObject({ pricing_model: "CPM" });
  });

  test("surfaces a failure result when the campaign create returns no id", async () => {
    enqueue({ data: {} });
    const result = await programmaticDspProvider.createCampaign({ accessToken: "token" }, "adv_1", {
      organizationId: "org",
      adAccountId: "local-account",
      name: "Broken",
      objective: "traffic",
      budgetType: "daily",
      budgetAmount: 5,
    });
    expect(result).toEqual({ success: false, error: "DSP campaign create returned no id" });
  });

  test("fails closed when the DSP endpoint is not configured", async () => {
    delete process.env.PROGRAMMATIC_DSP_ENDPOINT;
    const result = await programmaticDspProvider.createCampaign({ accessToken: "token" }, "adv_1", {
      organizationId: "org",
      adAccountId: "local-account",
      name: "No Endpoint",
      objective: "traffic",
      budgetType: "daily",
      budgetAmount: 5,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("PROGRAMMATIC_DSP_ENDPOINT is not configured");
    expect(calls.length).toBe(0);
  });

  test("rejects a non-https DSP endpoint", async () => {
    process.env.PROGRAMMATIC_DSP_ENDPOINT = "http://dsp.example.com";
    await expect(programmaticDspProvider.listAdAccounts({ accessToken: "token" })).rejects.toThrow(
      "PROGRAMMATIC_DSP_ENDPOINT must use https",
    );
    expect(calls.length).toBe(0);
  });

  test("rejects a malformed DSP endpoint", async () => {
    process.env.PROGRAMMATIC_DSP_ENDPOINT = "not-a-url";
    await expect(programmaticDspProvider.listAdAccounts({ accessToken: "token" })).rejects.toThrow(
      "PROGRAMMATIC_DSP_ENDPOINT must be an absolute URL",
    );
  });

  test("updates campaign flight and line item pricing/targeting from a composite id", async () => {
    enqueue({ data: { id: "cmp_1" } });
    enqueue({ data: { id: "li_1" } });

    const result = await programmaticDspProvider.updateCampaign(
      { accessToken: "token" },
      "adv_1/cmp_1/li_1",
      {
        name: "Renamed",
        budgetAmount: 50,
        bidStrategy: "cpa",
        endDate: new Date("2026-07-10T00:00:00Z"),
        targeting: { locations: ["GB"] },
      },
    );

    expect(result).toEqual({ success: true, externalCampaignId: "adv_1/cmp_1/li_1" });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/rtb/campaigns/cmp_1",
      "/rtb/line-items/li_1",
    ]);
    expect(jsonBody(calls[0] as FetchCall)).toEqual({
      name: "Renamed",
      flight_end: "2026-07-10T00:00:00.000Z",
      budget_micros: 50_000_000,
    });
    expect(jsonBody(calls[1] as FetchCall)).toEqual({
      pricing_model: "CPA",
      bid_floor_micros: 50_000_000,
      targeting: { geo: { country: ["GB"] } },
    });
  });

  test("skips the line item patch when a two-part id has no line item", async () => {
    enqueue({ data: { id: "cmp_1" } });
    const result = await programmaticDspProvider.updateCampaign(
      { accessToken: "token" },
      "adv_1/cmp_1",
      { name: "Renamed" },
    );
    expect(result).toMatchObject({ success: true });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/rtb/campaigns/cmp_1"]);
  });

  test("patches campaign and line item status for pause and activation", async () => {
    enqueue({ data: { id: "cmp_1" } });
    enqueue({ data: { id: "li_1" } });
    enqueue({ data: { id: "cmp_1" } });
    enqueue({ data: { id: "li_1" } });

    await expect(
      programmaticDspProvider.pauseCampaign({ accessToken: "token" }, "adv_1/cmp_1/li_1"),
    ).resolves.toMatchObject({ success: true });
    await expect(
      programmaticDspProvider.activateCampaign({ accessToken: "token" }, "adv_1/cmp_1/li_1"),
    ).resolves.toMatchObject({ success: true });

    expect(jsonBody(calls[0] as FetchCall)).toEqual({ status: "PAUSED" });
    expect(jsonBody(calls[1] as FetchCall)).toEqual({ status: "PAUSED" });
    expect(jsonBody(calls[2] as FetchCall)).toEqual({ status: "ACTIVE" });
    expect(jsonBody(calls[3] as FetchCall)).toEqual({ status: "ACTIVE" });
  });

  test("archives line item then campaign on delete", async () => {
    enqueue({ data: { id: "li_1" } });
    enqueue({ data: { id: "cmp_1" } });
    await expect(
      programmaticDspProvider.deleteCampaign({ accessToken: "token" }, "adv_1/cmp_1/li_1"),
    ).resolves.toEqual({ success: true });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/rtb/line-items/li_1",
      "/rtb/campaigns/cmp_1",
    ]);
    expect(jsonBody(calls[0] as FetchCall)).toEqual({ status: "ARCHIVED" });
    expect(jsonBody(calls[1] as FetchCall)).toEqual({ status: "ARCHIVED" });
  });

  test("creates an OpenRTB creative and associates it with the line item", async () => {
    enqueue({ data: { id: "crv_1" } });
    enqueue({ data: { id: "assoc_1" } });

    const result = await programmaticDspProvider.createCreative(
      { accessToken: "token" },
      "adv_1",
      "adv_1/cmp_1/li_1",
      {
        campaignId: "campaign-local",
        name: "Launch Creative",
        type: "image",
        headline: "Try the app",
        primaryText: "A useful app for builders",
        callToAction: "learn_more",
        destinationUrl: "https://example.com/path",
        media: [
          {
            id: "00000000-0000-4000-8000-000000000002",
            source: "upload",
            url: "https://cdn.example.com/ad-second.png",
            type: "image",
            order: 1,
          },
          {
            id: "00000000-0000-4000-8000-000000000001",
            source: "upload",
            url: "https://cdn.example.com/ad-first.png",
            type: "image",
            order: 0,
          },
        ],
      },
    );

    expect(result).toEqual({ success: true, externalCreativeId: "crv_1/assoc_1" });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/rtb/advertisers/adv_1/creatives",
      "/rtb/line-items/li_1/creatives",
    ]);
    expect(jsonBody(calls[0] as FetchCall)).toMatchObject({
      name: "Launch Creative",
      status: "PENDING_REVIEW",
      ad: {
        crid: "Launch Creative",
        seat: "seat_42",
        title: "Try the app",
        body: "A useful app for builders",
        cta: "learn_more",
        adomain: ["example.com"],
        landing_url: "https://example.com/path",
        format: "banner",
        assets: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            type: "image",
            link: "https://example.com/path",
          },
          {
            id: "00000000-0000-4000-8000-000000000002",
            type: "image",
            link: "https://example.com/path",
          },
        ],
      },
    });
    expect(jsonBody(calls[1] as FetchCall)).toEqual({ creative_id: "crv_1", status: "PAUSED" });
  });

  test("marks a creative as a video ad when any media is video", async () => {
    enqueue({ data: { id: "crv_1" } });
    enqueue({ data: { id: "assoc_1" } });
    await programmaticDspProvider.createCreative(
      { accessToken: "token" },
      "adv_1",
      "adv_1/cmp_1/li_1",
      {
        campaignId: "campaign-local",
        name: "Video Creative",
        type: "video",
        media: [
          {
            id: "00000000-0000-4000-8000-000000000009",
            source: "upload",
            url: "https://cdn.example.com/ad.mp4",
            type: "video",
            order: 0,
          },
        ],
      },
    );
    expect(jsonBody(calls[0] as FetchCall)).toMatchObject({ ad: { format: "video" } });
  });

  test("rejects creative creation without a line item in the composite id", async () => {
    const result = await programmaticDspProvider.createCreative(
      { accessToken: "token" },
      "adv_1",
      "adv_1/cmp_1",
      {
        campaignId: "campaign-local",
        name: "Creative",
        type: "image",
        media: [],
      },
    );
    expect(result).toEqual({
      success: false,
      error: "DSP creative requires a composite advertiser/campaign/line-item id",
    });
    expect(calls.length).toBe(0);
  });

  test("maps hosted media URLs into stable external URL assets and rejects unsafe URLs", async () => {
    await expect(
      programmaticDspProvider.uploadMedia?.({ accessToken: "token" }, "adv_1", {
        name: "Launch Creative",
        type: "image",
        url: "https://example.com/ad.png",
      }),
    ).resolves.toMatchObject({
      success: true,
      providerAssetId: "dsp-url:Launch-Creative",
      providerAssetUrl: "https://example.com/ad.png",
      providerAssetResourceName: "https://example.com/ad.png",
      metadata: { storage: "external_url", type: "image" },
    });

    await expect(
      programmaticDspProvider.uploadMedia?.({ accessToken: "token" }, "adv_1", {
        type: "image",
        url: "http://127.0.0.1/ad.png",
      }),
    ).resolves.toMatchObject({
      success: false,
      error: "Private or reserved IP addresses are not allowed",
    });
  });

  test("reports media assets as immediately available", async () => {
    await expect(
      programmaticDspProvider.getMediaStatus?.({ accessToken: "token" }, "adv_1", {
        providerAssetResourceName: "https://example.com/ad.png",
      }),
    ).resolves.toEqual({
      success: true,
      providerAssetId: "https://example.com/ad.png",
      providerAssetUrl: "https://example.com/ad.png",
      providerAssetResourceName: "https://example.com/ad.png",
      status: "AVAILABLE",
      ready: true,
    });
  });

  test("queries DSP reports and sums campaign metrics with derived rates", async () => {
    enqueue({
      data: {
        rows: [
          {
            spend: "12.5",
            impressions: "1000",
            clicks: "25",
            conversions: "2",
            conversion_value: "40",
          },
          { spend: 7.5, impressions: 500, clicks: 5, conversions: 1, conversion_value: 10 },
        ],
      },
    });

    const result = await programmaticDspProvider.getCampaignMetrics(
      { accessToken: "token" },
      "adv_1/cmp_1/li_1",
      { start: new Date("2026-07-01T12:34:00Z"), end: new Date("2026-07-02T12:34:00Z") },
    );

    expect(result).toEqual({
      success: true,
      metrics: {
        spend: 20,
        impressions: 1500,
        clicks: 30,
        conversions: 3,
        conversionValue: 50,
        ctr: 30 / 1500,
        cpc: 20 / 30,
        cpm: (20 / 1500) * 1000,
        roas: 50 / 20,
      },
    });
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/rtb/advertisers/adv_1/reports");
    expect(jsonBody(calls[0] as FetchCall)).toMatchObject({
      start_date: "2026-07-01T12:34:00.000Z",
      end_date: "2026-07-02T12:34:00.000Z",
      group_by: ["campaign_id"],
      metrics: ["spend", "impressions", "clicks", "conversions", "conversion_value"],
      filter: { campaign_id: "cmp_1" },
    });
  });

  test("returns zeroed metrics for an empty report", async () => {
    enqueue({ data: { rows: [] } });
    const result = await programmaticDspProvider.getCampaignMetrics(
      { accessToken: "token" },
      "adv_1/cmp_1/li_1",
    );
    expect(result).toEqual({
      success: true,
      metrics: {
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        conversionValue: 0,
        ctr: 0,
        cpc: 0,
        cpm: 0,
        roas: 0,
      },
    });
  });

  test("metrics fail closed when the id is not composite", async () => {
    const result = await programmaticDspProvider.getCampaignMetrics(
      { accessToken: "token" },
      "cmp_only",
    );
    expect(result).toEqual({
      success: false,
      error: "DSP metrics require a composite advertiser/campaign id",
    });
    expect(calls.length).toBe(0);
  });

  test("omits the seat field on line items when no seat is provisioned", async () => {
    delete process.env.PROGRAMMATIC_DSP_SEAT_ID;
    enqueue({ data: { id: "cmp_1" } });
    enqueue({ data: { id: "li_1" } });
    await programmaticDspProvider.createCampaign({ accessToken: "token" }, "adv_1", {
      organizationId: "org",
      adAccountId: "local-account",
      name: "No Seat",
      objective: "traffic",
      budgetType: "daily",
      budgetAmount: 5,
    });
    const body = jsonBody(calls[1] as FetchCall) as Record<string, unknown>;
    expect("seat" in body ? body.seat : undefined).toBeUndefined();
  });
});
