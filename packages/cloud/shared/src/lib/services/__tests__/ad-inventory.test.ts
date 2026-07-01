/**
 * Ad Inventory / SSP (#10687) — real Drizzle schema, in-process PGlite.
 *
 * Drives the money-critical serve path end to end: an eligible active campaign
 * fills a publisher slot, the advertiser's pre-funded campaign budget is
 * debited, and the publisher's redeemable earnings are credited (idempotent on
 * the impression id). Also covers eligibility (paused slot, no-budget, and
 * no-self-serve) and click dedup.
 *
 * Self-skips LOUDLY if PGlite/pushSchema is unavailable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../../db/client";
import { adAccounts } from "../../../db/schemas/ad-accounts";
import { adCampaigns } from "../../../db/schemas/ad-campaigns";
import { adCreatives } from "../../../db/schemas/ad-creatives";
import { adSlotEvents, adSlots } from "../../../db/schemas/ad-slots";
import {
  appDeploymentStatusEnum,
  appReviewStatusEnum,
  apps,
  userDatabaseStatusEnum,
} from "../../../db/schemas/apps";
import { organizations } from "../../../db/schemas/organizations";
import {
  earningsSourceEnum,
  ledgerEntryTypeEnum,
  redeemableEarnings,
  redeemableEarningsLedger,
  redeemedEarningsTracking,
} from "../../../db/schemas/redeemable-earnings";
import {
  secretEnvironmentEnum,
  secretProviderEnum,
  secretScopeEnum,
  secrets,
} from "../../../db/schemas/secrets";
import { users } from "../../../db/schemas/users";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;
let service: typeof import("../ad-inventory").adInventoryService;

let seq = 0;
const uniq = (p: string) => `${p}-${(seq += 1)}-${Math.random().toString(36).slice(2, 8)}`;

async function seedPublisher() {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Pub", slug: uniq("pub") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("pub-u"), organization_id: org.id })
    .returning();
  const [app] = await dbWrite
    .insert(apps)
    .values({
      name: "Pub App",
      slug: uniq("app"),
      organization_id: org.id,
      created_by_user_id: user.id,
      app_url: "https://placeholder.invalid",
    })
    .returning();
  return { orgId: org.id, userId: user.id, appId: app.id };
}

async function seedAdvertiserCampaign(
  opts: { status?: string; allocated?: string; spent?: string } = {},
) {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Adv", slug: uniq("adv") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("adv-u"), organization_id: org.id })
    .returning();
  const [account] = await dbWrite
    .insert(adAccounts)
    .values({
      organization_id: org.id,
      connected_by_user_id: user.id,
      platform: "meta",
      external_account_id: uniq("acct"),
      account_name: "Adv Account",
    })
    .returning();
  const [campaign] = await dbWrite
    .insert(adCampaigns)
    .values({
      organization_id: org.id,
      ad_account_id: account.id,
      name: "Campaign",
      platform: "meta",
      objective: "awareness",
      status: opts.status ?? "active",
      budget_type: "daily",
      credits_allocated: opts.allocated ?? "100.00",
      credits_spent: opts.spent ?? "0.00",
    })
    .returning();
  const [creative] = await dbWrite
    .insert(adCreatives)
    .values({
      campaign_id: campaign.id,
      name: "Creative",
      type: "image",
      status: "active",
      headline: "Buy widgets",
      destination_url: "https://advertiser.example.com",
    })
    .returning();
  return { orgId: org.id, campaignId: campaign.id, creativeId: creative.id };
}

async function creatorBalance(userId: string): Promise<number> {
  const row = await dbWrite.query.redeemableEarnings.findFirst({
    where: eq(redeemableEarnings.user_id, userId),
  });
  return Number(row?.available_balance ?? 0);
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    ({ adInventoryService: service } = await import("../ad-inventory"));
    const schema = {
      organizations,
      users,
      apps,
      secrets,
      secretScopeEnum,
      secretEnvironmentEnum,
      secretProviderEnum,
      adAccounts,
      adCampaigns,
      adCreatives,
      adSlots,
      adSlotEvents,
      redeemableEarnings,
      redeemableEarningsLedger,
      redeemedEarningsTracking,
      appDeploymentStatusEnum,
      appReviewStatusEnum,
      userDatabaseStatusEnum,
      earningsSourceEnum,
      ledgerEntryTypeEnum,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error("[ad-inventory.test] PGlite/pushSchema unavailable — skipping.", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("Ad Inventory / SSP (#10687)", () => {
  beforeEach(async () => {
    if (pgliteReady) await dbWrite.update(adCampaigns).set({ status: "paused" });
  });

  test("pglite applied (loud)", () => {
    expect(pgliteReady).toBe(true);
  });

  test("serving a slot debits the advertiser and credits the publisher", async () => {
    if (!pgliteReady) return;
    const pub = await seedPublisher();
    const adv = await seedAdvertiserCampaign(); // 100 allocated, 0 spent
    const slot = await service.createSlot({
      appId: pub.appId,
      organizationId: pub.orgId,
      name: "Header",
      format: "banner",
      floorCpm: 20, // $0.02/impression; publisher 70% = $0.014
    });

    const served = await service.serveAd(slot);
    expect(served).not.toBeNull();
    expect(served?.campaignId).toBe(adv.campaignId);
    expect(served?.headline).toBe("Buy widgets");
    expect(served?.revenue).toBeCloseTo(0.014, 6);

    // Advertiser campaign debited by the full price ($0.002).
    const campaign = await dbWrite.query.adCampaigns.findFirst({
      where: eq(adCampaigns.id, adv.campaignId),
    });
    expect(Number(campaign?.credits_spent)).toBeCloseTo(0.02, 6);
    expect(campaign?.total_impressions).toBe(1);

    // Publisher credited its 70% share.
    expect(await creatorBalance(pub.userId)).toBeCloseTo(0.014, 6);
  });

  test("a paused slot serves nothing", async () => {
    if (!pgliteReady) return;
    const pub = await seedPublisher();
    await seedAdvertiserCampaign();
    const slot = await service.createSlot({
      appId: pub.appId,
      organizationId: pub.orgId,
      name: "S",
      format: "banner",
      floorCpm: 1,
    });
    await service.updateSlot(slot.id, { status: "paused" });
    const paused = await service.getSlot(slot.id);
    expect(await service.serveAd(paused!)).toBeNull();
  });

  test("no eligible ad when the only campaign has no budget", async () => {
    if (!pgliteReady) return;
    const pub = await seedPublisher();
    await seedAdvertiserCampaign({ allocated: "5.00", spent: "5.00" }); // exhausted
    const slot = await service.createSlot({
      appId: pub.appId,
      organizationId: pub.orgId,
      name: "S",
      format: "banner",
      floorCpm: 1,
    });
    expect(await service.serveAd(slot)).toBeNull();
    expect(await creatorBalance(pub.userId)).toBe(0);
  });

  test("serve does not overspend a campaign whose remaining budget is below the impression price", async () => {
    if (!pgliteReady) return;
    const pub = await seedPublisher();
    const adv = await seedAdvertiserCampaign({
      allocated: "0.01",
      spent: "0.00",
    });
    const slot = await service.createSlot({
      appId: pub.appId,
      organizationId: pub.orgId,
      name: "S",
      format: "banner",
      floorCpm: 20, // $0.02/impression, more than the remaining $0.01
    });

    expect(await service.serveAd(slot)).toBeNull();

    const campaign = await dbWrite.query.adCampaigns.findFirst({
      where: eq(adCampaigns.id, adv.campaignId),
    });
    expect(Number(campaign?.credits_spent)).toBe(0);
    expect(campaign?.total_impressions).toBe(0);
    expect(await creatorBalance(pub.userId)).toBe(0);
    const events = await dbWrite
      .select()
      .from(adSlotEvents)
      .where(eq(adSlotEvents.slot_id, slot.id));
    expect(events).toHaveLength(0);
  });

  test("a publisher cannot serve its own org's campaign (no self-serve)", async () => {
    if (!pgliteReady) return;
    const pub = await seedPublisher();
    // Advertiser account/campaign in the SAME org as the publisher.
    const [account] = await dbWrite
      .insert(adAccounts)
      .values({
        organization_id: pub.orgId,
        connected_by_user_id: pub.userId,
        platform: "meta",
        external_account_id: uniq("acct"),
        account_name: "Self",
      })
      .returning();
    await dbWrite.insert(adCampaigns).values({
      organization_id: pub.orgId,
      ad_account_id: account.id,
      name: "Self Campaign",
      platform: "meta",
      objective: "awareness",
      status: "active",
      budget_type: "daily",
      credits_allocated: "100.00",
    });
    const slot = await service.createSlot({
      appId: pub.appId,
      organizationId: pub.orgId,
      name: "S",
      format: "banner",
      floorCpm: 1,
    });
    expect(await service.serveAd(slot)).toBeNull();
  });

  test("clicks are recorded once (dedup on impression id)", async () => {
    if (!pgliteReady) return;
    const pub = await seedPublisher();
    await seedAdvertiserCampaign();
    const slot = await service.createSlot({
      appId: pub.appId,
      organizationId: pub.orgId,
      name: "S",
      format: "banner",
      floorCpm: 1,
    });
    const served = await service.serveAd(slot);
    expect(served).not.toBeNull();
    expect(await service.recordClick(slot.id, served!.impressionId)).toBe(true);
    expect(await service.recordClick(slot.id, served!.impressionId)).toBe(false); // dup
    const after = await service.getSlot(slot.id);
    expect(after?.total_clicks).toBe(1);
    // a click for an unknown impression is ignored
    expect(await service.recordClick(slot.id, "nope")).toBe(false);
  });

  test("a click cannot be attributed to a different slot than its impression", async () => {
    if (!pgliteReady) return;
    const pub = await seedPublisher();
    await seedAdvertiserCampaign();
    const slot = await service.createSlot({
      appId: pub.appId,
      organizationId: pub.orgId,
      name: "Original",
      format: "banner",
      floorCpm: 20,
    });
    const otherSlot = await service.createSlot({
      appId: pub.appId,
      organizationId: pub.orgId,
      name: "Other",
      format: "banner",
      floorCpm: 20,
    });
    const served = await service.serveAd(slot);
    expect(served).not.toBeNull();

    expect(await service.recordClick(otherSlot.id, served!.impressionId)).toBe(false);
    expect((await service.getSlot(slot.id))?.total_clicks).toBe(0);
    expect((await service.getSlot(otherSlot.id))?.total_clicks).toBe(0);
  });

  test("two serves credit the publisher per impression", async () => {
    if (!pgliteReady) return;
    const pub = await seedPublisher();
    await seedAdvertiserCampaign();
    const slot = await service.createSlot({
      appId: pub.appId,
      organizationId: pub.orgId,
      name: "S",
      format: "banner",
      floorCpm: 20,
    });
    await service.serveAd(slot);
    await service.serveAd(slot);
    expect(await creatorBalance(pub.userId)).toBeCloseTo(0.028, 6);
    const events = await dbWrite
      .select()
      .from(adSlotEvents)
      .where(eq(adSlotEvents.slot_id, slot.id));
    expect(events.filter((e) => e.type === "impression")).toHaveLength(2);
  });
});
