// Exercises ad campaign bid strategy behavior with deterministic cloud-shared lib fixtures.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  adAccountsRepository,
  adCampaignsRepository,
  adTransactionsRepository,
} from "../../../db/repositories";
import { advertisingService } from "../advertising";
import { mapBidControlsToGoogleCampaign } from "../advertising/providers/google";
import { mapBidControlsToMetaAdSet } from "../advertising/providers/meta";
import { validateTikTokCampaignBidControls } from "../advertising/providers/tiktok";
import { CreateCampaignSchema, UpdateCampaignSchema } from "../advertising/schemas";
import type { AdProvider, CreateCampaignInput } from "../advertising/types";
import { appPromotionService } from "../app-promotion";
import { appsService } from "../apps";
import { contentSafetyService } from "../content-safety";
import { creditsService } from "../credits";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000002";

const spies: Array<{ mockRestore: () => void }> = [];
function track<T extends { mockRestore: () => void }>(s: T): T {
  spies.push(s);
  return s;
}

function makeCreateInput(over: Partial<CreateCampaignInput> = {}): CreateCampaignInput {
  return {
    organizationId: ORG_ID,
    adAccountId: ACCOUNT_ID,
    name: "Launch campaign",
    objective: "traffic",
    budgetType: "daily",
    budgetAmount: 100,
    budgetCurrency: "USD",
    ...over,
  };
}

function stubProvider(over: Partial<AdProvider> = {}): AdProvider {
  return {
    platform: "meta",
    createCampaign: async () => ({ success: true, externalCampaignId: "external-1" }),
    updateCampaign: async () => ({ success: true }),
    deleteCampaign: async () => ({ success: true }),
    ...over,
  } as unknown as AdProvider;
}

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

describe("ad campaign bid controls schemas", () => {
  test("accept supported bid strategies and optimization goals", () => {
    expect(
      CreateCampaignSchema.parse({
        organizationId: ORG_ID,
        adAccountId: ACCOUNT_ID,
        name: "Launch campaign",
        objective: "traffic",
        budgetType: "daily",
        budgetAmount: 100,
        bidStrategy: "cpc",
        optimizationGoal: "clicks",
      }),
    ).toMatchObject({
      bidStrategy: "cpc",
      optimizationGoal: "clicks",
    });

    expect(
      UpdateCampaignSchema.parse({
        bidStrategy: "cpa",
        optimizationGoal: "conversions",
      }),
    ).toMatchObject({
      bidStrategy: "cpa",
      optimizationGoal: "conversions",
    });
  });

  test("reject unsupported bid strategy values", () => {
    expect(() =>
      CreateCampaignSchema.parse({
        organizationId: ORG_ID,
        adAccountId: ACCOUNT_ID,
        name: "Launch campaign",
        objective: "traffic",
        budgetType: "daily",
        budgetAmount: 100,
        bidStrategy: "roas",
      }),
    ).toThrow();
  });
});

describe("ad provider bid-control mapping", () => {
  test("maps Meta CPC/click controls onto ad set billing and optimization fields", () => {
    expect(
      mapBidControlsToMetaAdSet(
        makeCreateInput({ bidStrategy: "cpc", optimizationGoal: "clicks" }),
      ),
    ).toEqual({
      billing_event: "LINK_CLICKS",
      optimization_goal: "LINK_CLICKS",
    });
  });

  test("maps Meta CPA/conversion controls onto conversion optimization", () => {
    expect(
      mapBidControlsToMetaAdSet(
        makeCreateInput({ bidStrategy: "cpa", optimizationGoal: "conversions" }),
      ),
    ).toEqual({
      billing_event: "IMPRESSIONS",
      optimization_goal: "OFFSITE_CONVERSIONS",
    });
  });

  test("maps Google campaign controls to bidding strategy fields", () => {
    expect(mapBidControlsToGoogleCampaign({ bidStrategy: "cpm" })).toEqual({ manualCpm: {} });
    expect(mapBidControlsToGoogleCampaign({ bidStrategy: "cpc" })).toEqual({ manualCpc: {} });
    expect(mapBidControlsToGoogleCampaign({ bidStrategy: "cpa" })).toEqual({
      maximizeConversions: {},
    });
  });

  test("rejects TikTok campaign-level bid controls explicitly", () => {
    expect(validateTikTokCampaignBidControls({ bidStrategy: "cpc" })).toEqual({
      success: false,
      error:
        "TikTok campaign creation does not support campaign-level bid strategy controls through this adapter",
    });
  });
});

describe("advertisingService bid controls persistence", () => {
  test("createCampaign persists bid controls in campaign metadata and passes them to the provider", async () => {
    track(
      spyOn(adAccountsRepository, "findById").mockResolvedValue({
        id: ACCOUNT_ID,
        organization_id: ORG_ID,
        platform: "meta",
        external_account_id: "act_1",
        status: "active",
      } as never),
    );
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
      ).mockResolvedValue({ accessToken: "token" } as never),
    );

    const provider = stubProvider();
    const createOnProvider = track(spyOn(provider, "createCampaign"));
    track(spyOn(advertisingService, "getProvider").mockReturnValue(provider));
    // createCampaign persists via the spend-cap-checked atomic create, not the
    // bare create(); mock that variant with its { status, campaign } result.
    const createRow = track(
      spyOn(adCampaignsRepository, "createWithAccountSpendCapCheck").mockImplementation(
        async (data) =>
          ({
            status: "created",
            campaign: { ...(data as Record<string, unknown>), id: "campaign-row-1" },
          }) as never,
      ),
    );
    track(spyOn(adTransactionsRepository, "create").mockResolvedValue({} as never));

    const input = makeCreateInput({
      bidStrategy: "cpc",
      optimizationGoal: "clicks",
    });

    await advertisingService.createCampaign(input);

    expect(createOnProvider).toHaveBeenCalledWith({ accessToken: "token" }, "act_1", input);
    expect(createRow.mock.calls[0]?.[0]).toMatchObject({
      metadata: {
        bid_strategy: "cpc",
        optimization_goal: "clicks",
      },
    });
  });

  test("createCampaign rejects TikTok bid controls before safety review, credits, or provider calls", async () => {
    track(
      spyOn(adAccountsRepository, "findById").mockResolvedValue({
        id: ACCOUNT_ID,
        organization_id: ORG_ID,
        platform: "tiktok",
        external_account_id: "act_1",
        status: "active",
      } as never),
    );
    const safety = track(spyOn(contentSafetyService, "assertSafeForPublicUse"));
    const deduct = track(spyOn(creditsService, "deductCredits"));
    const provider = stubProvider({ platform: "tiktok" });
    const createOnProvider = track(spyOn(provider, "createCampaign"));
    track(spyOn(advertisingService, "getProvider").mockReturnValue(provider));

    await expect(
      advertisingService.createCampaign(
        makeCreateInput({
          bidStrategy: "cpc",
          optimizationGoal: "clicks",
        }),
      ),
    ).rejects.toThrow(
      "TikTok campaign creation does not support campaign-level bid strategy controls",
    );

    expect(safety).not.toHaveBeenCalled();
    expect(deduct).not.toHaveBeenCalled();
    expect(createOnProvider).not.toHaveBeenCalled();
  });

  test("updateCampaign rejects bid-control changes before touching money or the platform", async () => {
    // No adapter applies bid-control changes to a live campaign, so the
    // service must fail closed instead of persisting metadata drift.
    const findCampaign = track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue({
        id: "campaign-1",
        organization_id: ORG_ID,
        ad_account_id: ACCOUNT_ID,
        external_campaign_id: "external-1",
        name: "Launch campaign",
        credits_allocated: "110",
        budget_amount: "100",
        metadata: { external_ad_set_ids: ["adset-1"] },
      } as never),
    );
    const deduct = track(
      spyOn(creditsService, "deductCredits").mockResolvedValue({
        success: true,
        transaction: { id: "tx-1" },
      } as never),
    );
    const refund = track(spyOn(creditsService, "refundCredits").mockResolvedValue({} as never));
    const provider = stubProvider();
    const updateOnProvider = track(spyOn(provider, "updateCampaign"));
    track(spyOn(advertisingService, "getProvider").mockReturnValue(provider));
    const updateRow = track(
      spyOn(adCampaignsRepository, "update").mockImplementation(async (_id, data) => data as never),
    );

    await expect(
      advertisingService.updateCampaign("campaign-1", ORG_ID, {
        bidStrategy: "cpa",
        optimizationGoal: "conversions",
      }),
    ).rejects.toThrow(/only be set at campaign creation/);

    expect(findCampaign).not.toHaveBeenCalled();
    expect(deduct).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
    expect(updateOnProvider).not.toHaveBeenCalled();
    expect(updateRow).not.toHaveBeenCalled();
  });
});

describe("appPromotionService bid controls", () => {
  test("passes promotion bid controls through to advertising campaign creation", async () => {
    track(
      spyOn(appsService, "getById").mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000003",
        organization_id: ORG_ID,
        name: "Test App",
        app_url: "https://example.test",
      } as never),
    );
    track(
      spyOn(creditsService, "deductCredits").mockResolvedValue({
        success: false,
      } as never),
    );
    const createCampaign = track(
      spyOn(advertisingService, "createCampaign").mockResolvedValue({
        id: "campaign-1",
        name: "Test App - Promotion Campaign",
      } as never),
    );

    await appPromotionService.promoteApp(ORG_ID, "user-1", "app-1", {
      channels: ["advertising"],
      advertising: {
        platform: "meta",
        adAccountId: ACCOUNT_ID,
        budget: 100,
        budgetType: "daily",
        objective: "traffic",
        bidStrategy: "cpc",
        optimizationGoal: "clicks",
      },
    });

    expect(createCampaign.mock.calls[0]?.[0]).toMatchObject({
      bidStrategy: "cpc",
      optimizationGoal: "clicks",
    });
  });
});
