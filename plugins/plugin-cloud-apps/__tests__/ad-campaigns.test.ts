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
  setDuplicateAdCampaign,
  setUpdateAdCampaignDayparting,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { duplicateAdCampaignAction, setAdCampaignDaypartingAction } =
  await import("../src/actions/ad-campaigns.ts");

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
