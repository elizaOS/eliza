// Exercises ad campaign performance report behavior with deterministic cloud-shared lib fixtures.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  adAccountsRepository,
  adCampaignsRepository,
  adConversionsRepository,
  adReportSharesRepository,
} from "../../../db/repositories";
import type { AdReportShare } from "../../../db/schemas/ad-report-shares";
import { advertisingService } from "../advertising";

const ORG_ID = "org-1";
const OTHER_ORG_ID = "org-2";
const CAMPAIGN_ID = "campaign-1";
const ACCOUNT_ID = "account-1";

const spies: Array<{ mockRestore: () => void }> = [];
function track<T extends { mockRestore: () => void }>(s: T): T {
  spies.push(s);
  return s;
}

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

function makeCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: CAMPAIGN_ID,
    organization_id: ORG_ID,
    ad_account_id: ACCOUNT_ID,
    external_campaign_id: null,
    name: "Launch, Report",
    platform: "meta",
    objective: "traffic",
    status: "active",
    budget_type: "daily",
    budget_amount: "200.00",
    budget_currency: "USD",
    credits_allocated: "220.00",
    credits_spent: "44.00",
    start_date: new Date("2026-07-01T00:00:00.000Z"),
    end_date: new Date("2026-07-31T00:00:00.000Z"),
    targeting: {},
    total_spend: "40.00",
    total_impressions: 2000,
    total_clicks: 100,
    total_conversions: 10,
    app_id: "app-1",
    metadata: {},
    created_at: new Date("2026-07-01T00:00:00.000Z"),
    updated_at: new Date("2026-07-02T00:00:00.000Z"),
    ...overrides,
  } as never;
}

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    organization_id: ORG_ID,
    connected_by_user_id: "user-1",
    platform: "meta",
    external_account_id: "act_1",
    account_name: "Meta Ads",
    access_token_secret_id: "secret-1",
    refresh_token_secret_id: null,
    status: "active",
    metadata: {},
    created_at: new Date("2026-07-01T00:00:00.000Z"),
    updated_at: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  } as never;
}

function makeShare(overrides: Partial<AdReportShare> = {}): AdReportShare {
  return {
    id: "share-1",
    organization_id: ORG_ID,
    campaign_id: CAMPAIGN_ID,
    token_hash: "hash",
    status: "active",
    expires_at: new Date(Date.now() + 60_000),
    revoked_at: null,
    created_by_user_id: "user-1",
    created_at: new Date("2026-07-02T00:00:00.000Z"),
    updated_at: new Date("2026-07-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("campaign performance reports (#11600)", () => {
  test("computes report metrics server-side from campaign totals", async () => {
    track(spyOn(adCampaignsRepository, "findById").mockResolvedValue(makeCampaign()));
    track(spyOn(adAccountsRepository, "findById").mockResolvedValue(makeAccount()));
    track(
      spyOn(adConversionsRepository, "getCampaignRollup").mockResolvedValue({
        conversions: 0,
        value: 0,
      }),
    );

    const report = await advertisingService.getCampaignPerformanceReport(CAMPAIGN_ID, ORG_ID);

    expect(report.campaign).toMatchObject({
      id: CAMPAIGN_ID,
      name: "Launch, Report",
      budgetAmount: 200,
      creditsAllocated: 220,
    });
    expect(report.summary).toMatchObject({
      spend: 40,
      impressions: 2000,
      clicks: 100,
      conversions: 10,
      ctr: 5,
      cpc: 0.4,
      cpm: 20,
      conversionRate: 10,
      costPerConversion: 4,
      budgetUtilization: 20,
    });
    expect(report.provider).toMatchObject({
      externalAccountId: "act_1",
      externalCampaignId: null,
    });
  });

  test("denies cross-org report access", async () => {
    track(spyOn(adCampaignsRepository, "findById").mockResolvedValue(makeCampaign()));
    await expect(
      advertisingService.getCampaignPerformanceReport(CAMPAIGN_ID, OTHER_ORG_ID),
    ).rejects.toThrow("Campaign not found");
  });

  test("formats reports as CSV with escaped campaign names", async () => {
    track(spyOn(adCampaignsRepository, "findById").mockResolvedValue(makeCampaign()));
    track(spyOn(adAccountsRepository, "findById").mockResolvedValue(makeAccount()));
    track(
      spyOn(adConversionsRepository, "getCampaignRollup").mockResolvedValue({
        conversions: 0,
        value: 0,
      }),
    );

    const report = await advertisingService.getCampaignPerformanceReport(CAMPAIGN_ID, ORG_ID);
    const csv = advertisingService.formatCampaignPerformanceCsv(report);

    expect(csv).toContain("campaign_id,campaign_name,platform");
    expect(csv).toContain('campaign-1,"Launch, Report",meta');
    expect(csv).toContain(",40,2000,100,10,5,0.4,20,10,4,20,0,");
  });

  test("creates hash-backed public report shares", async () => {
    track(spyOn(adCampaignsRepository, "findById").mockResolvedValue(makeCampaign()));
    const create = track(
      spyOn(adReportSharesRepository, "create").mockImplementation(async (input) => {
        expect(input.token_hash).toHaveLength(64);
        expect(input.token_hash).not.toContain("token");
        return makeShare({
          id: "share-created",
          token_hash: input.token_hash,
          expires_at: input.expires_at,
        });
      }),
    );

    const share = await advertisingService.createCampaignReportShare({
      organizationId: ORG_ID,
      userId: "user-1",
      campaignId: CAMPAIGN_ID,
      expiresAt: new Date("2026-07-10T00:00:00.000Z"),
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(share).toMatchObject({
      id: "share-created",
      campaignId: CAMPAIGN_ID,
      expiresAt: "2026-07-10T00:00:00.000Z",
    });
    expect(share.token.length).toBeGreaterThan(20);
    expect(share.publicPath).toContain("/api/v1/advertising/reports/");
  });

  test("rejects expired and revoked public report shares", async () => {
    const findByTokenHash = track(spyOn(adReportSharesRepository, "findByTokenHash"));
    findByTokenHash.mockResolvedValueOnce(makeShare({ expires_at: new Date(Date.now() - 1000) }));
    await expect(
      advertisingService.getPublicCampaignPerformanceReport("expired-token"),
    ).rejects.toThrow("Report share not found or expired");

    findByTokenHash.mockResolvedValueOnce(makeShare({ status: "revoked" }));
    await expect(
      advertisingService.getPublicCampaignPerformanceReport("revoked-token"),
    ).rejects.toThrow("Report share not found or expired");
  });
});
