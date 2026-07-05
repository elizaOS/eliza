/**
 * Error-path proof for the advertising service's provider-fetch boundary (#13415):
 * a failed provider metrics fetch PROPAGATES (fails closed — never fabricates a
 * zero-spend success), and that failure is distinguishable from a legitimately
 * unsynced campaign, which returns its stored first-party metrics without ever
 * calling the provider. Repository / secrets / meta-provider seams are
 * deterministic in-memory fakes; no monetary value is asserted beyond the
 * stored-value passthrough the source already fixes.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type MetricsResult = {
  success: boolean;
  error?: string;
  metrics?: {
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
  };
};

let metaMetricsResult: MetricsResult;
let providerMetricsCalls = 0;
let campaignRow: Record<string, unknown> | null;
let accountRow: Record<string, unknown> | null;

mock.module("../../../db/repositories", () => ({
  adAccountsRepository: { findById: async () => accountRow },
  adCampaignsRepository: {
    findById: async () => campaignRow,
    updateMetrics: async () => {},
  },
  adConversionsRepository: {
    getCampaignRollup: async () => ({ conversions: 0, value: 0 }),
  },
  adAudienceSegmentsRepository: {},
  adCreativesRepository: {},
  adReportSharesRepository: {},
  adTransactionsRepository: {},
}));

mock.module("../secrets", () => ({
  secretsService: { getDecryptedValue: async () => "access-token" },
}));

mock.module("../credits", () => ({ creditsService: {} }));
mock.module("../content-safety", () => ({ contentSafetyService: {} }));

mock.module("./providers/meta", () => ({
  metaAdsProvider: {
    getCampaignMetrics: async (): Promise<MetricsResult> => {
      providerMetricsCalls += 1;
      return metaMetricsResult;
    },
  },
}));

const { advertisingService } = await import("./index");

function syncedCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "camp_1",
    organization_id: "org_1",
    ad_account_id: "acct_1",
    external_campaign_id: "ext_camp_1",
    credits_allocated: "100.00",
    budget_amount: "50.00",
    credits_spent: "0.00",
    total_spend: "12.34",
    total_impressions: 1000,
    total_clicks: 10,
    total_conversions: 2,
    ...overrides,
  };
}

const metaAccount = {
  id: "acct_1",
  organization_id: "org_1",
  platform: "meta",
  external_account_id: "ext_acct_1",
  access_token_secret_id: "sec_access",
  refresh_token_secret_id: null,
  token_expires_at: null,
};

beforeEach(() => {
  providerMetricsCalls = 0;
  campaignRow = syncedCampaign();
  accountRow = metaAccount;
  metaMetricsResult = {
    success: true,
    metrics: { spend: 5, impressions: 5, clicks: 5, conversions: 5 },
  };
});

afterEach(() => {
  mock.restore();
});

describe("advertisingService.getCampaignMetrics — provider-fetch boundary", () => {
  test("a failed provider fetch PROPAGATES (fails closed, no fabricated success)", async () => {
    metaMetricsResult = { success: false, error: "meta insights api unavailable (503)" };

    await expect(advertisingService.getCampaignMetrics("camp_1", "org_1")).rejects.toThrow(
      "meta insights api unavailable (503)",
    );
    // The provider WAS reached — this is a real transport failure surfacing,
    // not a short-circuit before the fetch.
    expect(providerMetricsCalls).toBe(1);
  });

  test("a success envelope with missing metrics still throws — never fabricates", async () => {
    metaMetricsResult = { success: true };

    await expect(advertisingService.getCampaignMetrics("camp_1", "org_1")).rejects.toThrow(
      "Failed to get metrics",
    );
    expect(providerMetricsCalls).toBe(1);
  });

  test("a legitimately unsynced campaign is DISTINCT: stored metrics, no provider call", async () => {
    campaignRow = syncedCampaign({ external_campaign_id: null });

    const result = await advertisingService.getCampaignMetrics("camp_1", "org_1");

    // No provider fetch happens, and the absent-provider case resolves with the
    // stored value — distinguishable from the throw a failed fetch produces, and
    // NOT a zero fabricated by a swallowed error.
    expect(providerMetricsCalls).toBe(0);
    expect(result.spend).toBe(Number.parseFloat(String(syncedCampaign().total_spend)));
    expect(result.impressions).toBe(1000);
  });

  test("an absent campaign fails closed distinctly (not a provider error)", async () => {
    campaignRow = null;

    await expect(advertisingService.getCampaignMetrics("camp_1", "org_1")).rejects.toThrow(
      "Campaign not found",
    );
    expect(providerMetricsCalls).toBe(0);
  });
});
