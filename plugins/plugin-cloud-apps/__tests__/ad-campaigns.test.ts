/**
 * Ad-campaign management action tests (SET_AD_CAMPAIGN_DAYPARTING, performance reports). The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type {
  DuplicateAdCampaignInput,
  UpdateCampaignDaypartingInput,
} from "@elizaos/cloud-sdk";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeMessage,
  resetSdk,
  setCreateAdCampaignReportShare,
  setDuplicateAdCampaign,
  setGetAdCampaignPerformanceReport,
  setUpdateAdCampaignDayparting,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const {
  duplicateAdCampaignAction,
  exportAdCampaignReportAction,
  setAdCampaignDaypartingAction,
} = await import("../src/actions/ad-campaigns.ts");

const SCHEDULE = {
  timezone: "America/Los_Angeles",
  windows: [
    { daysOfWeek: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "17:00" },
  ],
};

describe("SET_AD_CAMPAIGN_DAYPARTING", () => {
  beforeEach(() => resetSdk());

  it("validate: true with key, false without", async () => {
    expect(
      await setAdCampaignDaypartingAction.validate(
        keyedRuntime(),
        makeMessage("x"),
      ),
    ).toBe(true);
    expect(
      await setAdCampaignDaypartingAction.validate(
        unkeyedRuntime(),
        makeMessage("x"),
      ),
    ).toBe(false);
  });

  it("no key -> no_key", async () => {
    const cb = captureCallback();
    const res = await setAdCampaignDaypartingAction.handler(
      unkeyedRuntime(),
      makeMessage("schedule campaign"),
      undefined,
      {},
      cb.callback,
    );
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ reason: "no_key" });
  });

  it("updates dayparting through the SDK boundary", async () => {
    let captured: {
      campaignId: string;
      input: UpdateCampaignDaypartingInput;
    } | null = null;
    setUpdateAdCampaignDayparting((campaignId, input) => {
      captured = { campaignId, input };
      return Promise.resolve({
        success: true,
        campaignId,
        status: "draft",
        dayparting: input.dayparting,
        updatedAt: "2026-07-02T00:00:00.000Z",
      });
    });
    const cb = captureCallback();
    const res = await setAdCampaignDaypartingAction.handler(
      keyedRuntime(),
      makeMessage("schedule campaign"),
      undefined,
      { campaignId: "campaign_1", dayparting: SCHEDULE },
      cb.callback,
    );
    expect(res.success).toBe(true);
    expect(captured).toEqual({
      campaignId: "campaign_1",
      input: { dayparting: SCHEDULE },
    });
    expect(res.userFacingText).toContain("1 dayparting window");
  });
});

describe("DUPLICATE_AD_CAMPAIGN", () => {
  beforeEach(() => resetSdk());

  it("requires a campaign id", async () => {
    const cb = captureCallback();
    const res = await duplicateAdCampaignAction.handler(
      keyedRuntime(),
      makeMessage("duplicate campaign"),
      undefined,
      {},
      cb.callback,
    );
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ reason: "missing_campaign_id" });
  });

  it("duplicates through the SDK boundary", async () => {
    let captured: {
      campaignId: string;
      input?: DuplicateAdCampaignInput;
    } | null = null;
    setDuplicateAdCampaign((campaignId, input) => {
      captured = { campaignId, input };
      return Promise.resolve({
        success: true,
        campaign: {
          id: "copy_1",
          name: input?.name ?? "Copy",
          platform: "meta",
          objective: "traffic",
          status: "draft",
          budgetType: "daily",
          budgetAmount: "50.00",
          budgetCurrency: "USD",
          creditsAllocated: "0.00",
          externalCampaignId: null,
          sourceCampaignId: campaignId,
          createdAt: "2026-07-02T00:00:00.000Z",
        },
        creativesCopied: 2,
      });
    });
    const cb = captureCallback();
    const res = await duplicateAdCampaignAction.handler(
      keyedRuntime(),
      makeMessage("duplicate campaign"),
      undefined,
      { campaignId: "campaign_1", name: "Summer Campaign Copy" },
      cb.callback,
    );
    expect(res.success).toBe(true);
    expect(captured).toEqual({
      campaignId: "campaign_1",
      input: { name: "Summer Campaign Copy" },
    });
    expect(res.userFacingText).toContain("2 creative");
  });
});

describe("EXPORT_AD_CAMPAIGN_REPORT", () => {
  beforeEach(() => resetSdk());

  it("requires a campaign id", async () => {
    const cb = captureCallback();
    const res = await exportAdCampaignReportAction.handler(
      keyedRuntime(),
      makeMessage("export campaign report"),
      undefined,
      {},
      cb.callback,
    );
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ reason: "missing_campaign_id" });
  });

  it("exports server-computed campaign metrics through the SDK boundary", async () => {
    let captured: string | null = null;
    setGetAdCampaignPerformanceReport((campaignId) => {
      captured = campaignId;
      return Promise.resolve({
        success: true,
        report: {
          generatedAt: "2026-07-03T00:00:00.000Z",
          campaign: {
            id: campaignId,
            name: "Launch Push",
            platform: "meta",
            objective: "traffic",
            status: "active",
            externalCampaignId: "ext_1",
            appId: null,
            budgetType: "daily",
            budgetAmount: 200,
            budgetCurrency: "USD",
            creditsAllocated: 220,
            creditsSpent: 44,
            startDate: null,
            endDate: null,
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-03T00:00:00.000Z",
          },
          dateRange: null,
          summary: {
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
            conversionValue: 0,
          },
          provider: {
            platform: "meta",
            accountId: "acct_1",
            externalAccountId: "external_acct",
            externalCampaignId: "ext_1",
          },
        },
      });
    });
    const cb = captureCallback();
    const res = await exportAdCampaignReportAction.handler(
      keyedRuntime(),
      makeMessage("export report"),
      undefined,
      { campaignId: "campaign_1" },
      cb.callback,
    );
    expect(res.success).toBe(true);
    expect(captured).toBe("campaign_1");
    expect(res.userFacingText).toContain("Launch Push");
    expect(res.userFacingText).toContain("CTR: 5.00%");
  });

  it("creates an expiring share link when requested", async () => {
    let shareInput: { campaignId: string; expiresInHours?: number } | null =
      null;
    setCreateAdCampaignReportShare((campaignId, input) => {
      shareInput = { campaignId, expiresInHours: input?.expiresInHours };
      return Promise.resolve({
        success: true,
        share: {
          id: "share_1",
          campaignId,
          token: "token_1",
          publicPath: "/api/v1/advertising/reports/token_1",
          publicUrl: "https://elizacloud.ai/api/v1/advertising/reports/token_1",
          expiresAt: "2026-07-10T00:00:00.000Z",
        },
      });
    });
    const cb = captureCallback();
    const res = await exportAdCampaignReportAction.handler(
      keyedRuntime(),
      makeMessage("share report"),
      undefined,
      { campaignId: "campaign_1", share: true, expiresInHours: 48 },
      cb.callback,
    );
    expect(res.success).toBe(true);
    expect(shareInput).toEqual({
      campaignId: "campaign_1",
      expiresInHours: 48,
    });
    expect(res.userFacingText).toContain("Share link:");
    expect(res.userFacingText).toContain(
      "https://elizacloud.ai/api/v1/advertising/reports/token_1",
    );
  });
});
