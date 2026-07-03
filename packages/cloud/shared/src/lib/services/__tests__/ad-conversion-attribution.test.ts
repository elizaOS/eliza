/**
 * First-party campaign conversion attribution (#11598).
 *
 * Tests the real advertisingService token/UTM/analytics logic. Repository
 * boundaries are spied so the test proves signing, ownership, dedupe handoff,
 * deterministic UTM storage, and analytics rollup without booting a provider.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { adCampaignsRepository, adConversionsRepository } from "../../../db/repositories";
import type { AdCampaign } from "../../../db/schemas/ad-campaigns";
import type { AdAttributionLink, AdConversionEvent } from "../../../db/schemas/ad-conversions";
import { advertisingService } from "../advertising";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";
const APP_ID = "33333333-3333-4333-8333-333333333333";

const spies: Array<{ mockRestore: () => void }> = [];
function track<T extends { mockRestore: () => void }>(s: T): T {
  spies.push(s);
  return s;
}

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

function makeCampaign(over: Partial<AdCampaign> = {}): AdCampaign {
  return {
    id: CAMPAIGN_ID,
    organization_id: ORG_ID,
    ad_account_id: "acct-1",
    external_campaign_id: null,
    name: "Launch Campaign",
    platform: "meta",
    objective: "traffic",
    status: "active",
    budget_type: "daily",
    budget_amount: "100.00",
    budget_currency: "USD",
    credits_allocated: "110.00",
    credits_spent: "0.00",
    start_date: null,
    end_date: null,
    targeting: {},
    total_spend: "15.00",
    total_impressions: 1000,
    total_clicks: 25,
    total_conversions: 3,
    app_id: APP_ID,
    metadata: {},
    created_at: new Date("2026-07-02T00:00:00Z"),
    updated_at: new Date("2026-07-02T00:00:00Z"),
    ...over,
  } as AdCampaign;
}

describe("conversion attribution token", () => {
  test("records a signed conversion and surfaces dedupe results", async () => {
    let campaign = makeCampaign();
    track(spyOn(adCampaignsRepository, "findById").mockImplementation(async () => campaign));
    track(
      spyOn(adCampaignsRepository, "update").mockImplementation(async (_id, patch) => {
        campaign = makeCampaign({ metadata: patch.metadata as AdCampaign["metadata"] });
        return campaign;
      }),
    );

    let first = true;
    const record = track(
      spyOn(adConversionsRepository, "recordConversion").mockImplementation(async (input) => {
        const event = {
          id: first ? "event-1" : "event-1",
          organization_id: input.organization_id,
          campaign_id: input.campaign_id,
          app_id: input.app_id ?? null,
          creative_id: null,
          event_type: input.event_type,
          dedupe_key: input.dedupe_key,
          value: input.value ?? null,
          currency: input.currency,
          source_url: input.source_url ?? null,
          referrer: input.referrer ?? null,
          user_agent: input.user_agent ?? null,
          metadata: input.metadata ?? {},
          occurred_at: input.occurred_at ?? new Date(),
          created_at: new Date(),
        } as AdConversionEvent;
        const inserted = first;
        first = false;
        return { event, inserted };
      }),
    );

    const token = await advertisingService.getAttributionToken(CAMPAIGN_ID, ORG_ID);
    expect(token.campaignId).toBe(CAMPAIGN_ID);
    expect(token.appId).toBe(APP_ID);
    expect(typeof campaign.metadata.attribution_token_secret).toBe("string");

    const inserted = await advertisingService.recordConversion({
      token: token.token,
      eventType: "purchase",
      dedupeKey: "order-123",
      value: 42,
      currency: "USD",
      sourceUrl: "https://app.example/thanks?utm_source=meta",
      referrer: "https://app.example/checkout",
      userAgent: "test-agent",
      metadata: { checkoutId: "checkout-1" },
    });
    const replay = await advertisingService.recordConversion({
      token: token.token,
      eventType: "purchase",
      dedupeKey: "order-123",
    });

    expect(inserted.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      organization_id: ORG_ID,
      campaign_id: CAMPAIGN_ID,
      app_id: APP_ID,
      event_type: "purchase",
      dedupe_key: "order-123",
      value: "42.00",
      user_agent: "test-agent",
    });
  });

  test("rejects a tampered attribution token before insertion", async () => {
    const campaign = makeCampaign({ metadata: { attribution_token_secret: "secret" } });
    track(spyOn(adCampaignsRepository, "findById").mockResolvedValue(campaign));
    const record = track(spyOn(adConversionsRepository, "recordConversion"));

    const token = await advertisingService.getAttributionToken(CAMPAIGN_ID, ORG_ID);
    const tampered = token.token.replace(/\.$/, ".x");
    await expect(
      advertisingService.recordConversion({
        token: `${tampered}x`,
        eventType: "conversion",
        dedupeKey: "event-1",
      }),
    ).rejects.toThrow("Invalid attribution token");
    expect(record).not.toHaveBeenCalled();
  });
});

describe("UTM attribution links", () => {
  test("stores and reuses a deterministic campaign UTM URL", async () => {
    const campaign = makeCampaign();
    track(spyOn(adCampaignsRepository, "findById").mockResolvedValue(campaign));
    const stored = {
      id: "link-1",
      organization_id: ORG_ID,
      campaign_id: CAMPAIGN_ID,
      creative_id: null,
      app_id: APP_ID,
      destination_url: "https://example.com/install",
      utm_url:
        "https://example.com/install?utm_source=meta&utm_medium=paid&utm_campaign=launch-campaign",
      utm_source: "meta",
      utm_medium: "paid",
      utm_campaign: "launch-campaign",
      utm_content: null,
      utm_term: null,
      created_at: new Date(),
    } as AdAttributionLink;
    const find = track(
      spyOn(adConversionsRepository, "findAttributionLink")
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(stored),
    );
    const create = track(
      spyOn(adConversionsRepository, "createAttributionLink").mockResolvedValue(stored),
    );

    const first = await advertisingService.createAttributionLink({
      campaignId: CAMPAIGN_ID,
      organizationId: ORG_ID,
      destinationUrl: "https://example.com/install",
    });
    const second = await advertisingService.createAttributionLink({
      campaignId: CAMPAIGN_ID,
      organizationId: ORG_ID,
      destinationUrl: "https://example.com/install",
    });

    expect(first.utmUrl).toContain("utm_campaign=launch-campaign");
    expect(second.id).toBe("link-1");
    expect(find).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("campaign metrics attribution rollup", () => {
  test("adds first-party conversion count and value without losing provider totals", async () => {
    track(spyOn(adCampaignsRepository, "findById").mockResolvedValue(makeCampaign()));
    track(
      spyOn(adConversionsRepository, "getCampaignRollup").mockResolvedValue({
        conversions: 2,
        value: 99.5,
      }),
    );

    const metrics = await advertisingService.getCampaignMetrics(CAMPAIGN_ID, ORG_ID);

    expect(metrics.providerConversions).toBe(3);
    expect(metrics.firstPartyConversions).toBe(2);
    expect(metrics.conversions).toBe(5);
    expect(metrics.conversionValue).toBe(99.5);
  });
});
