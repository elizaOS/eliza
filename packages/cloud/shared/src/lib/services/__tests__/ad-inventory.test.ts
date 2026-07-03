/**
 * Ad Inventory / SSP (#10687) — real Drizzle schema, in-process PGlite.
 *
 * Drives the money-critical serve path end to end: an eligible active campaign
 * fills a publisher slot, the advertiser's pre-funded campaign budget is
 * debited, and the publisher's redeemable earnings are credited (idempotent on
 * the impression id). Also covers eligibility (paused slot, no-budget, and
 * no-self-serve) and click dedup.
 *
 * Fails loudly (via the `pgliteReady` guard) if PGlite/pushSchema ever fails to initialize — never a silent skip.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// This proof owns its DB: force an isolated in-memory PGlite regardless of the
// ambient DATABASE_URL / TEST_DATABASE_URL the CI lane exports. resolveDatabaseUrl
// prefers TEST_DATABASE_URL, so BOTH are pinned — otherwise the suite is steered
// to a Postgres that isn't up under the unit lane and self-skips to a vacuous
// green (a money-path proof shipping unproven).
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../../db/client";
import { adSlotsRepository } from "../../../db/repositories/ad-slots";
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

import { redeemableEarningsService } from "../redeemable-earnings";

const PGLITE_TIMEOUT = 180_000;
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
  opts: {
    status?: string;
    accountStatus?: "active" | "pending" | "suspended" | "disconnected";
    allocated?: string;
    spent?: string;
    dayparting?: {
      timezone: string;
      windows: Array<{ daysOfWeek: number[]; startTime: string; endTime: string }>;
    };
  } = {},
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
      status: opts.accountStatus ?? "active",
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
      ...(opts.dayparting ? { metadata: { dayparting: opts.dayparting } } : {}),
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
  return {
    orgId: org.id,
    accountId: account.id,
    campaignId: campaign.id,
    creativeId: creative.id,
  };
}

async function creatorBalance(userId: string): Promise<number> {
  const row = await dbWrite.query.redeemableEarnings.findFirst({
    where: eq(redeemableEarnings.user_id, userId),
  });
  return Number(row?.available_balance ?? 0);
}

beforeAll(async () => {
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
      floorCpm: 20,
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
      floorCpm: 20,
    });
    expect(await service.serveAd(slot)).toBeNull();
    expect(await creatorBalance(pub.userId)).toBe(0);
  });

  test("no eligible ad when the campaign account is suspended", async () => {
    if (!pgliteReady) return;
    const pub = await seedPublisher();
    await seedAdvertiserCampaign({ accountStatus: "suspended" });
    const slot = await service.createSlot({
      appId: pub.appId,
      organizationId: pub.orgId,
      name: "S",
      format: "banner",
      floorCpm: 20,
    });

    expect(await service.serveAd(slot)).toBeNull();
    expect(await creatorBalance(pub.userId)).toBe(0);
  });

  test("serve debit gate re-checks account status after candidate selection", async () => {
    if (!pgliteReady) return;
    const pub = await seedPublisher();
    const adv = await seedAdvertiserCampaign();
    const slot = await service.createSlot({
      appId: pub.appId,
      organizationId: pub.orgId,
      name: "Race",
      format: "banner",
      floorCpm: 20,
    });

    await dbWrite
      .update(adAccounts)
      .set({ status: "suspended" })
      .where(eq(adAccounts.id, adv.accountId));

    const event = await adSlotsRepository.recordServe({
      slotId: slot.id,
      campaignId: adv.campaignId,
      creativeId: adv.creativeId,
      impressionId: uniq("impression"),
      price: 0.02,
      publisherRevenue: 0.014,
    });

    expect(event).toBeNull();
    const campaign = await dbWrite.query.adCampaigns.findFirst({
      where: eq(adCampaigns.id, adv.campaignId),
    });
    expect(Number(campaign?.credits_spent)).toBe(0);
    expect(campaign?.total_impressions).toBe(0);
    const events = await dbWrite
      .select()
      .from(adSlotEvents)
      .where(eq(adSlotEvents.slot_id, slot.id));
    expect(events).toHaveLength(0);
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
        status: "active",
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
      floorCpm: 20,
    });
    expect(await service.serveAd(slot)).toBeNull();
  });

  test("dayparting gates the serve path: outside its window a campaign is neither served nor billed (#11599)", async () => {
    if (!pgliteReady) return;
    const pub = await seedPublisher();
    // A window that can never contain "now": keyed to a UTC weekday 3 days away.
    const offWindowDay = (new Date().getUTCDay() + 3) % 7;
    const adv = await seedAdvertiserCampaign({
      dayparting: {
        timezone: "UTC",
        windows: [{ daysOfWeek: [offWindowDay], startTime: "00:00", endTime: "24:00" }],
      },
    });
    const slot = await service.createSlot({
      appId: pub.appId,
      organizationId: pub.orgId,
      name: "S",
      format: "banner",
      floorCpm: 20,
    });

    expect(await service.serveAd(slot)).toBeNull();

    const campaign = await dbWrite.query.adCampaigns.findFirst({
      where: eq(adCampaigns.id, adv.campaignId),
    });
    expect(Number(campaign?.credits_spent)).toBe(0);
    expect(campaign?.total_impressions).toBe(0);
    expect(await creatorBalance(pub.userId)).toBe(0);
  });

  test("dayparting: an in-window campaign serves while a richer out-of-window competitor is skipped", async () => {
    if (!pgliteReady) return;
    const pub = await seedPublisher();
    const offWindowDay = (new Date().getUTCDay() + 3) % 7;
    // Bigger budget — would win the budget-ranked selection without the gate.
    const blocked = await seedAdvertiserCampaign({
      allocated: "500.00",
      dayparting: {
        timezone: "UTC",
        windows: [{ daysOfWeek: [offWindowDay], startTime: "00:00", endTime: "24:00" }],
      },
    });
    const allowed = await seedAdvertiserCampaign({
      dayparting: {
        timezone: "UTC",
        windows: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: "00:00", endTime: "24:00" }],
      },
    });
    const slot = await service.createSlot({
      appId: pub.appId,
      organizationId: pub.orgId,
      name: "S",
      format: "banner",
      floorCpm: 20,
    });

    const served = await service.serveAd(slot);
    expect(served).not.toBeNull();
    expect(served?.campaignId).toBe(allowed.campaignId);

    const blockedRow = await dbWrite.query.adCampaigns.findFirst({
      where: eq(adCampaigns.id, blocked.campaignId),
    });
    expect(Number(blockedRow?.credits_spent)).toBe(0);
    expect(blockedRow?.total_impressions).toBe(0);
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
      floorCpm: 20,
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

  // Regression for the zero-debit value mint: at the OLD default floor CPM of
  // $1 the per-impression price is $0.001, which rounds to a $0.00 advertiser
  // debit at the credits ledger's scale-2 while the publisher would still have
  // earned $0.0007 — free money. Sub-cent prices must be refused outright.
  test("sub-cent pricing is refused — no money is minted at a $0.00 debit", async () => {
    if (!pgliteReady) return;
    const pub = await seedPublisher();
    const adv = await seedAdvertiserCampaign(); // active, 100 allocated
    const slot = await service.createSlot({
      appId: pub.appId,
      organizationId: pub.orgId,
      name: "Sub-cent",
      format: "banner",
      floorCpm: 1, // $0.001/impression → $0.00 at the debit scale
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

  test("the schema-default floor CPM is billable: debit >= payout, always", async () => {
    if (!pgliteReady) return;
    const pub = await seedPublisher();
    const adv = await seedAdvertiserCampaign();
    // Raw insert without floor_cpm — exercises the column default.
    const [slot] = await dbWrite
      .insert(adSlots)
      .values({
        app_id: pub.appId,
        organization_id: pub.orgId,
        name: "Default floor",
        format: "banner",
      })
      .returning();
    expect(slot.floor_cpm).toBe("10.0000"); // minimum billable CPM

    const served = await service.serveAd(slot);
    expect(served).not.toBeNull();

    const campaign = await dbWrite.query.adCampaigns.findFirst({
      where: eq(adCampaigns.id, adv.campaignId),
    });
    const debit = Number(campaign?.credits_spent);
    const payout = await creatorBalance(pub.userId);
    expect(debit).toBeCloseTo(0.01, 6);
    expect(payout).toBeCloseTo(0.007, 6);
    expect(debit).toBeGreaterThanOrEqual(payout);
  });

  test("serves stop exactly at the campaign allocation — sequential and concurrent", async () => {
    if (!pgliteReady) return;
    const pub = await seedPublisher();
    const adv = await seedAdvertiserCampaign({ allocated: "0.03", spent: "0.00" });
    const slot = await service.createSlot({
      appId: pub.appId,
      organizationId: pub.orgId,
      name: "Bounded",
      format: "banner",
      floorCpm: 10, // $0.01/impression → exactly 3 serves fit
    });

    expect(await service.serveAd(slot)).not.toBeNull();
    expect(await service.serveAd(slot)).not.toBeNull();
    expect(await service.serveAd(slot)).not.toBeNull();
    expect(await service.serveAd(slot)).toBeNull(); // budget exhausted

    const campaign = await dbWrite.query.adCampaigns.findFirst({
      where: eq(adCampaigns.id, adv.campaignId),
    });
    expect(Number(campaign?.credits_spent)).toBeCloseTo(0.03, 6);
    expect(campaign?.total_impressions).toBe(3);

    // Concurrent burst against a fresh campaign: the conditional debit
    // (credits_allocated - credits_spent >= price inside the tx) is the money
    // gate — total spend can never exceed the allocation.
    await dbWrite.update(adCampaigns).set({ status: "paused" });
    const burst = await seedAdvertiserCampaign({ allocated: "0.05", spent: "0.00" });
    const burstSlot = await service.createSlot({
      appId: pub.appId,
      organizationId: pub.orgId,
      name: "Burst",
      format: "banner",
      floorCpm: 10,
    });
    const results = await Promise.all(Array.from({ length: 10 }, () => service.serveAd(burstSlot)));
    const fills = results.filter((r) => r !== null).length;
    const burstCampaign = await dbWrite.query.adCampaigns.findFirst({
      where: eq(adCampaigns.id, burst.campaignId),
    });
    expect(fills).toBe(5);
    expect(Number(burstCampaign?.credits_spent)).toBeCloseTo(0.05, 6);
    expect(Number(burstCampaign?.credits_spent)).toBeLessThanOrEqual(
      Number(burstCampaign?.credits_allocated),
    );
  });

  test("a failed publisher payout is durable drift, settled on the next serve", async () => {
    if (!pgliteReady) return;
    const pub = await seedPublisher();
    await seedAdvertiserCampaign();
    const slot = await service.createSlot({
      appId: pub.appId,
      organizationId: pub.orgId,
      name: "Drift",
      format: "banner",
      floorCpm: 20,
    });

    // First serve: the earnings service is down. The advertiser debit commits,
    // and the impression row stays payout-unsettled — visible, not silent.
    const originalAddEarnings =
      redeemableEarningsService.addEarnings.bind(redeemableEarningsService);
    redeemableEarningsService.addEarnings = () => {
      throw new Error("earnings ledger unavailable");
    };
    let served: Awaited<ReturnType<typeof service.serveAd>>;
    try {
      served = await service.serveAd(slot);
    } finally {
      redeemableEarningsService.addEarnings = originalAddEarnings;
    }
    expect(served).not.toBeNull();
    expect(await creatorBalance(pub.userId)).toBe(0);
    const [pendingRow] = await dbWrite
      .select()
      .from(adSlotEvents)
      .where(eq(adSlotEvents.impression_id, served!.impressionId));
    expect(pendingRow.payout_settled_at).toBeNull();

    // Next serve heals the drift: both impressions settle, exactly once each.
    const second = await service.serveAd(slot);
    expect(second).not.toBeNull();
    expect(await creatorBalance(pub.userId)).toBeCloseTo(0.028, 6);
    const events = await dbWrite
      .select()
      .from(adSlotEvents)
      .where(eq(adSlotEvents.slot_id, slot.id));
    for (const event of events.filter((e) => e.type === "impression")) {
      expect(event.payout_settled_at).not.toBeNull();
    }

    // Settlement is idempotent: a replay moves no money.
    const replay = await service.settlePendingPayouts();
    expect(replay.settled).toBe(0);
    expect(await creatorBalance(pub.userId)).toBeCloseTo(0.028, 6);
  });
});
