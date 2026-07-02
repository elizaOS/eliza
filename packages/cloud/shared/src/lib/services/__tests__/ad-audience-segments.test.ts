import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  adAccountsRepository,
  adAudienceSegmentsRepository,
  adCampaignsRepository,
} from "../../../db/repositories";
import { advertisingService } from "../advertising";
import { CreateAudienceSegmentSchema } from "../advertising/schemas";
import type { AdProvider } from "../advertising/types";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000002";
const SEGMENT_ID = "00000000-0000-4000-8000-000000000010";
const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000020";

const spies: Array<{ mockRestore: () => void }> = [];
function track<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy);
  return spy;
}

function makeSegment(overrides: Record<string, unknown> = {}) {
  return {
    id: SEGMENT_ID,
    organization_id: ORG_ID,
    created_by_user_id: null,
    name: "Launch audience",
    description: "Primary launch target",
    targeting: {
      locations: ["US"],
      age_min: 21,
      age_max: 44,
      genders: ["all"],
      interests: ["ai tools"],
      behaviors: ["early adopters"],
      custom_audiences: ["ca_123"],
      excluded_audiences: ["ca_excluded"],
      placements: ["facebook"],
      languages: ["1001"],
    },
    metadata: {},
    created_at: new Date("2026-07-02T00:00:00.000Z"),
    updated_at: new Date("2026-07-02T00:00:00.000Z"),
    ...overrides,
  };
}

function makeCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: CAMPAIGN_ID,
    organization_id: ORG_ID,
    ad_account_id: "account-1",
    name: "Campaign",
    external_campaign_id: "external-1",
    budget_amount: "100",
    credits_allocated: "110",
    credits_spent: "0",
    total_spend: "0",
    targeting: {},
    ...overrides,
  };
}

function stubProvider(overrides: Partial<AdProvider> = {}): AdProvider {
  return {
    platform: "meta",
    updateCampaign: async () => ({ success: true }),
    ...overrides,
  } as unknown as AdProvider;
}

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("audience segment validation", () => {
  test("rejects inverted age ranges and mixed all/specific genders", () => {
    const parsed = CreateAudienceSegmentSchema.safeParse({
      name: "Bad segment",
      targeting: {
        ageMin: 45,
        ageMax: 30,
        genders: ["all", "male"],
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
      "ageMin must be less than or equal to ageMax",
    );
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
      "genders cannot combine all with specific genders",
    );
  });
});

describe("audience segment service", () => {
  test("persists validated targeting as the server-owned segment contract", async () => {
    const create = track(
      spyOn(adAudienceSegmentsRepository, "create").mockResolvedValue(makeSegment() as never),
    );

    const segment = await advertisingService.createAudienceSegment({
      organizationId: ORG_ID,
      userId: "00000000-0000-4000-8000-000000000030",
      name: "Launch audience",
      targeting: {
        locations: ["US"],
        ageMin: 21,
        ageMax: 44,
        genders: ["all"],
        interests: ["ai tools"],
        behaviors: ["early adopters"],
        customAudiences: ["ca_123"],
        excludedAudiences: ["ca_excluded"],
        placements: ["facebook"],
        languages: ["1001"],
      },
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      organization_id: ORG_ID,
      targeting: {
        age_min: 21,
        age_max: 44,
        custom_audiences: ["ca_123"],
        excluded_audiences: ["ca_excluded"],
      },
    });
    expect(segment.targeting).toMatchObject({
      ageMin: 21,
      ageMax: 44,
      customAudiences: ["ca_123"],
      excludedAudiences: ["ca_excluded"],
    });
  });

  test("denies applying a segment from another organization before campaign update", async () => {
    track(spyOn(adCampaignsRepository, "findById").mockResolvedValue(makeCampaign() as never));
    track(
      spyOn(adAudienceSegmentsRepository, "findById").mockResolvedValue(
        makeSegment({ organization_id: OTHER_ORG_ID }) as never,
      ),
    );
    const accountLookup = track(spyOn(adAccountsRepository, "findById"));

    await expect(
      advertisingService.applyAudienceSegmentToCampaign(SEGMENT_ID, CAMPAIGN_ID, ORG_ID),
    ).rejects.toThrow("Audience segment not found");

    expect(accountLookup).not.toHaveBeenCalled();
  });

  test("applies a same-org segment to an existing campaign targeting update", async () => {
    track(
      spyOn(adAudienceSegmentsRepository, "findById").mockResolvedValue(makeSegment() as never),
    );
    track(spyOn(adCampaignsRepository, "findById").mockResolvedValue(makeCampaign() as never));
    track(
      spyOn(adAccountsRepository, "findById").mockResolvedValue({
        id: "account-1",
        organization_id: ORG_ID,
        platform: "meta",
        status: "active",
      } as never),
    );
    track(
      spyOn(
        advertisingService as unknown as { getCredentials: () => Promise<unknown> },
        "getCredentials",
      ).mockResolvedValue({} as never),
    );
    track(spyOn(advertisingService, "getProvider").mockReturnValue(stubProvider()));
    const update = track(
      spyOn(adCampaignsRepository, "update").mockResolvedValue(
        makeCampaign({
          targeting: {
            locations: ["US"],
            age_min: 21,
            age_max: 44,
            custom_audiences: ["ca_123"],
            excluded_audiences: ["ca_excluded"],
          },
        }) as never,
      ),
    );

    const campaign = await advertisingService.applyAudienceSegmentToCampaign(
      SEGMENT_ID,
      CAMPAIGN_ID,
      ORG_ID,
    );

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[1]).toMatchObject({
      targeting: {
        age_min: 21,
        age_max: 44,
        custom_audiences: ["ca_123"],
        excluded_audiences: ["ca_excluded"],
      },
    });
    expect(campaign.targeting).toMatchObject({
      custom_audiences: ["ca_123"],
      excluded_audiences: ["ca_excluded"],
    });
  });
});
