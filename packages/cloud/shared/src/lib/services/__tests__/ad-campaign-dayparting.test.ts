import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { adAccountsRepository } from "../../../db/repositories/ad-accounts";
import { adCampaignsRepository } from "../../../db/repositories/ad-campaigns";
import { adCreativesRepository } from "../../../db/repositories/ad-creatives";
import { advertisingService } from "../advertising";
import { isWithinDayparting } from "../advertising/dayparting";
import { mapDaypartingToMetaAdSetSchedule } from "../advertising/providers/meta";
import type { CampaignDaypartingSchedule } from "../advertising/types";
import { creditsService } from "../credits";

const ORG_ID = "org-1";
const OTHER_ORG_ID = "org-2";
const CAMPAIGN_ID = "campaign-1";

const spies: Array<{ mockRestore: () => void }> = [];
function track<T extends { mockRestore: () => void }>(s: T): T {
  spies.push(s);
  return s;
}

const schedule: CampaignDaypartingSchedule = {
  timezone: "America/Los_Angeles",
  windows: [{ daysOfWeek: [5, 1, 3], startTime: "09:00", endTime: "17:30" }],
};

function makeCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: CAMPAIGN_ID,
    organization_id: ORG_ID,
    ad_account_id: "acct-1",
    external_campaign_id: null,
    name: "Launch",
    platform: "meta",
    objective: "traffic",
    status: "active",
    budget_type: "daily",
    budget_amount: "100.00",
    budget_currency: "USD",
    credits_allocated: "110.00",
    credits_spent: "10.00",
    start_date: new Date("2026-07-01T00:00:00.000Z"),
    end_date: new Date("2026-07-31T00:00:00.000Z"),
    targeting: { locations: ["US"] },
    total_spend: "4.00",
    total_impressions: 100,
    total_clicks: 5,
    total_conversions: 1,
    app_id: "app-1",
    metadata: {
      dayparting: schedule,
      external_ad_set_ids: ["adset-1"],
      external_ad_ids: ["ad-1"],
      last_sync_at: "2026-07-01T00:00:00.000Z",
    },
    created_at: new Date("2026-07-01T00:00:00.000Z"),
    updated_at: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeAdAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: "acct-1",
    organization_id: ORG_ID,
    platform: "meta",
    external_account_id: "act_1",
    account_name: "Meta Ads",
    status: "active",
    credentials_secret_id: "secret-1",
    currency: "USD",
    timezone: "America/Los_Angeles",
    metadata: {},
    created_at: new Date("2026-07-01T00:00:00.000Z"),
    updated_at: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

describe("advertising campaign dayparting", () => {
  test("rejects invalid timezone before persisting", async () => {
    track(spyOn(adCampaignsRepository, "findById").mockResolvedValue(makeCampaign() as never));
    const update = track(spyOn(adCampaignsRepository, "update"));

    await expect(
      advertisingService.updateCampaignDayparting(CAMPAIGN_ID, ORG_ID, {
        timezone: "Not/AZone",
        windows: [{ daysOfWeek: [1], startTime: "09:00", endTime: "17:00" }],
      }),
    ).rejects.toThrow("Unsupported IANA timezone");

    expect(update).not.toHaveBeenCalled();
  });

  test("rejects invalid local windows before persisting", async () => {
    track(spyOn(adCampaignsRepository, "findById").mockResolvedValue(makeCampaign() as never));
    const update = track(spyOn(adCampaignsRepository, "update"));

    await expect(
      advertisingService.updateCampaignDayparting(CAMPAIGN_ID, ORG_ID, {
        timezone: "America/Los_Angeles",
        windows: [{ daysOfWeek: [1], startTime: "17:00", endTime: "09:00" }],
      }),
    ).rejects.toThrow("endTime must be after startTime");

    expect(update).not.toHaveBeenCalled();
  });

  test("persists normalized dayparting on a local draft campaign", async () => {
    track(spyOn(adCampaignsRepository, "findById").mockResolvedValue(makeCampaign() as never));
    const update = track(
      spyOn(adCampaignsRepository, "update").mockImplementation(async (_id, data) => {
        return makeCampaign({ metadata: data.metadata, updated_at: new Date() }) as never;
      }),
    );

    const updated = await advertisingService.updateCampaignDayparting(
      CAMPAIGN_ID,
      ORG_ID,
      schedule,
    );

    expect(update).toHaveBeenCalledTimes(1);
    expect(updated.metadata.dayparting).toEqual({
      timezone: "America/Los_Angeles",
      windows: [{ daysOfWeek: [1, 3, 5], startTime: "09:00", endTime: "17:30" }],
    });
  });

  test("rejects dayparting on providers that cannot apply it before charging", async () => {
    track(
      spyOn(adAccountsRepository, "findById").mockResolvedValue(
        makeAdAccount({ platform: "google" }) as never,
      ),
    );
    const deductCredits = track(spyOn(creditsService, "deductCredits"));

    await expect(
      advertisingService.createCampaign({
        organizationId: ORG_ID,
        adAccountId: "acct-1",
        name: "Launch",
        objective: "traffic",
        budgetType: "daily",
        budgetAmount: 100,
        dayparting: schedule,
      }),
    ).rejects.toThrow("supported only for Meta");

    expect(deductCredits).not.toHaveBeenCalled();
  });

  test("rejects dayparting changes after provider sync instead of claiming sync", async () => {
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        makeCampaign({ external_campaign_id: "meta-campaign-1" }) as never,
      ),
    );
    const update = track(spyOn(adCampaignsRepository, "update"));

    await expect(
      advertisingService.updateCampaignDayparting(CAMPAIGN_ID, ORG_ID, schedule),
    ).rejects.toThrow("cannot be changed after provider sync");

    expect(update).not.toHaveBeenCalled();
  });

  test("maps dayparting to Meta ad-set schedule minutes", () => {
    expect(mapDaypartingToMetaAdSetSchedule(schedule)).toEqual([
      { days: [5, 1, 3], start_minute: 540, end_minute: 1050 },
    ]);
  });
});

describe("advertising campaign duplication", () => {
  test("denies cross-org duplicate before copying", async () => {
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        makeCampaign({ organization_id: OTHER_ORG_ID }) as never,
      ),
    );
    const createCampaign = track(spyOn(adCampaignsRepository, "create"));
    const createCreative = track(spyOn(adCreativesRepository, "create"));

    await expect(
      advertisingService.duplicateCampaign(CAMPAIGN_ID, ORG_ID, { name: "Copy" }),
    ).rejects.toThrow("Campaign not found");

    expect(createCampaign).not.toHaveBeenCalled();
    expect(createCreative).not.toHaveBeenCalled();
  });

  test("creates a draft local copy without provider, spend, or runtime creative state", async () => {
    track(spyOn(adCampaignsRepository, "findById").mockResolvedValue(makeCampaign() as never));
    track(
      spyOn(adCampaignsRepository, "create").mockImplementation(async (data) => {
        return makeCampaign({
          ...data,
          id: "campaign-copy",
          external_campaign_id: null,
          created_at: new Date("2026-07-02T00:00:00.000Z"),
          updated_at: new Date("2026-07-02T00:00:00.000Z"),
        }) as never;
      }),
    );
    track(
      spyOn(adCreativesRepository, "listByCampaign").mockResolvedValue([
        {
          id: "creative-1",
          campaign_id: CAMPAIGN_ID,
          external_creative_id: "provider-creative-1",
          name: "Creative",
          type: "image",
          status: "active",
          headline: "Hello",
          primary_text: "World",
          description: "Desc",
          call_to_action: "learn_more",
          destination_url: "https://example.com",
          media: [
            {
              id: "media-1",
              source: "upload",
              url: "https://example.com/ad.png",
              providerAssetId: "provider-asset-1",
              type: "image",
              order: 0,
            },
          ],
          metadata: {
            submitted_at: "2026-07-01T00:00:00.000Z",
            content_safety: {
              provider: "openai",
              flagged: false,
              flaggedCategories: [],
              issues: [],
            },
          },
          created_at: new Date("2026-07-01T00:00:00.000Z"),
          updated_at: new Date("2026-07-01T00:00:00.000Z"),
        },
      ] as never),
    );
    const createCreative = track(
      spyOn(adCreativesRepository, "create").mockResolvedValue({} as never),
    );

    const result = await advertisingService.duplicateCampaign(CAMPAIGN_ID, ORG_ID, {
      name: "Launch Copy",
    });

    expect(result.campaign).toMatchObject({
      id: "campaign-copy",
      name: "Launch Copy",
      status: "draft",
      external_campaign_id: null,
      credits_allocated: "0.00",
      credits_spent: "0.00",
      total_spend: "0.00",
      total_impressions: 0,
      total_clicks: 0,
      total_conversions: 0,
    });
    expect(result.campaign.metadata).toMatchObject({
      source_campaign_id: CAMPAIGN_ID,
      dayparting: schedule,
    });
    expect(result.campaign.metadata.external_ad_set_ids).toBeUndefined();
    expect(createCreative).toHaveBeenCalledTimes(1);
    const copied = createCreative.mock.calls[0]?.[0] as {
      status: string;
      external_creative_id?: string;
      media: Array<{ providerAssetId?: string }>;
      metadata: Record<string, unknown>;
    };
    expect(copied.status).toBe("draft");
    expect(copied.external_creative_id).toBeUndefined();
    expect(copied.media[0]?.providerAssetId).toBeUndefined();
    expect(copied.metadata).toEqual({
      content_safety: {
        provider: "openai",
        flagged: false,
        flaggedCategories: [],
        issues: [],
      },
    });
  });
});

describe("updateCampaign on an unsynced campaign", () => {
  test("rejects mixed non-dayparting fields instead of silently dropping them", async () => {
    track(spyOn(adCampaignsRepository, "findById").mockResolvedValue(makeCampaign() as never));
    const update = track(spyOn(adCampaignsRepository, "update"));

    await expect(
      advertisingService.updateCampaign(CAMPAIGN_ID, ORG_ID, {
        name: "Renamed",
        dayparting: schedule,
      }),
    ).rejects.toThrow("only dayparting can be updated before sync");

    expect(update).not.toHaveBeenCalled();
  });
});

describe("isWithinDayparting — explicit-timezone window evaluation", () => {
  // 2026-07-01T02:30:00Z is Wednesday 02:30 UTC == Tuesday June 30 19:30 in
  // America/Los_Angeles (PDT, UTC-7). daysOfWeek: 0=Sunday..6=Saturday.
  const AT = new Date("2026-07-01T02:30:00.000Z");

  test("matches in the schedule's own timezone, not UTC", () => {
    expect(
      isWithinDayparting(
        {
          timezone: "America/Los_Angeles",
          windows: [{ daysOfWeek: [2], startTime: "19:00", endTime: "20:00" }],
        },
        AT,
      ),
    ).toBe(true);
    // Same local window keyed to Wednesday (the UTC weekday) does NOT match —
    // proves evaluation uses the schedule timezone, not server/UTC time.
    expect(
      isWithinDayparting(
        {
          timezone: "America/Los_Angeles",
          windows: [{ daysOfWeek: [3], startTime: "19:00", endTime: "20:00" }],
        },
        AT,
      ),
    ).toBe(false);
    expect(
      isWithinDayparting(
        {
          timezone: "UTC",
          windows: [{ daysOfWeek: [3], startTime: "02:00", endTime: "03:00" }],
        },
        AT,
      ),
    ).toBe(true);
  });

  test("window bounds are half-open: [startTime, endTime)", () => {
    expect(
      isWithinDayparting(
        {
          timezone: "UTC",
          windows: [{ daysOfWeek: [3], startTime: "02:00", endTime: "02:30" }],
        },
        AT,
      ),
    ).toBe(false);
    expect(
      isWithinDayparting(
        {
          timezone: "UTC",
          windows: [{ daysOfWeek: [3], startTime: "02:30", endTime: "03:00" }],
        },
        AT,
      ),
    ).toBe(true);
  });

  test('"24:00" endTime covers through the last minute of the local day', () => {
    // 23:59:30 UTC on Wednesday July 1 — excluded by a 23:59 end, included by 24:00.
    const LATE = new Date("2026-07-01T23:59:30.000Z");
    expect(
      isWithinDayparting(
        {
          timezone: "UTC",
          windows: [{ daysOfWeek: [3], startTime: "00:00", endTime: "23:59" }],
        },
        LATE,
      ),
    ).toBe(false);
    expect(
      isWithinDayparting(
        {
          timezone: "UTC",
          windows: [{ daysOfWeek: [3], startTime: "00:00", endTime: "24:00" }],
        },
        LATE,
      ),
    ).toBe(true);
  });
});
