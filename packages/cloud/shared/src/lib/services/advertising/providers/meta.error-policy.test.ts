// Pins the error-surfacing contract of the Meta ad provider: a failed provider
// fetch must surface as a structured {success:false}/{valid:false} failure (the
// shape the advertising service reads to REFUND credits and to reject invalid
// credentials), and must stay distinct from a legitimately-empty result (valid
// account with no insights → success with zero spend). Deterministic — global
// fetch is mocked; no live Meta Graph API call and no monetary value is asserted
// beyond the zero the source already fixes for the empty-insights case.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../utils/logger", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

const { metaAdsProvider } = await import("./meta");

const originalFetch = globalThis.fetch;

function mockFetchJson(body: unknown, status = 200) {
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as typeof fetch;
}

function mockFetchReject(error: Error) {
  globalThis.fetch = mock(async () => {
    throw error;
  }) as typeof fetch;
}

const credentials = { accessToken: "token" };
const campaignInput = {
  name: "Spring Sale",
  objective: "traffic",
  budgetType: "daily" as const,
  budgetAmount: 50,
};

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("metaAdsProvider.validateCredentials error surfacing", () => {
  test("a transport failure surfaces as valid:false, never valid:true", async () => {
    mockFetchReject(new Error("network down"));

    const result = await metaAdsProvider.validateCredentials(credentials);

    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("a Meta API error (invalid token, code 190) surfaces as valid:false", async () => {
    mockFetchJson({
      error: { message: "Invalid OAuth access token", code: 190, type: "OAuthException" },
    });

    const result = await metaAdsProvider.validateCredentials({ accessToken: "bad-token" });

    expect(result.valid).toBe(false);
    // The provider error carries the upstream Meta message; a fetch failure never
    // masquerades as a valid account.
    expect(result.error).toContain("Invalid OAuth access token");
  });

  test("a healthy /me response resolves valid:true (distinct from failure)", async () => {
    mockFetchJson({ id: "123", name: "Acme Ads" });

    const result = await metaAdsProvider.validateCredentials(credentials);

    expect(result).toEqual({ valid: true, accountId: "123", accountName: "Acme Ads" });
  });
});

describe("metaAdsProvider.createCampaign error surfacing (credit-refund contract)", () => {
  test("a provider fetch failure returns {success:false} so the caller can refund", async () => {
    mockFetchReject(new Error("meta unreachable"));

    const result = await metaAdsProvider.createCampaign(credentials, "act_123", campaignInput);

    // The advertising service reads !result.success to refund allocated credits;
    // a swallowed throw here would skip that refund. Must never report success.
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("a Meta API error surfaces the upstream message on {success:false}", async () => {
    mockFetchJson({
      error: { message: "Invalid ad account", code: 100, type: "OAuthException" },
    });

    const result = await metaAdsProvider.createCampaign(credentials, "act_123", campaignInput);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid ad account");
  });
});

describe("metaAdsProvider.getCampaignMetrics failure vs legitimately-empty", () => {
  test("a transport failure returns {success:false}, NOT an empty success", async () => {
    mockFetchReject(new Error("insights fetch failed"));

    const result = await metaAdsProvider.getCampaignMetrics(credentials, "camp_1");

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.metrics).toBeUndefined();
  });

  test("an empty insights array is a success distinct from a failure", async () => {
    mockFetchJson({ data: [] });

    const result = await metaAdsProvider.getCampaignMetrics(credentials, "camp_1");

    // Meta returns no insights rows for a campaign with no delivery yet — a real,
    // non-failure empty. Source fixes zero spend for this case; we assert only the
    // distinction from the failure branch, not any derived monetary amount.
    expect(result.success).toBe(true);
    expect(result.metrics?.spend).toBe(0);
  });
});
