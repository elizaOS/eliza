/**
 * Influencer marketplace escrow (#10687) — real Drizzle schema, in-process PGlite.
 *
 * Drives the money-critical booking lifecycle: funding debits the advertiser's
 * org credits, approval releases the escrow to the influencer's redeemable
 * earnings, and rejection/cancel refunds the advertiser — each gated by an
 * atomic status CAS so a retry moves money exactly once.
 *
 * Self-skips LOUDLY if PGlite/pushSchema is unavailable.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../../db/client";
import { creditTransactions } from "../../../db/schemas/credit-transactions";
import {
  influencerBookings,
  influencerProfiles,
} from "../../../db/schemas/influencer-marketplace";
import { organizations } from "../../../db/schemas/organizations";
import {
  earningsSourceEnum,
  ledgerEntryTypeEnum,
  redeemableEarnings,
  redeemableEarningsLedger,
  redeemedEarningsTracking,
} from "../../../db/schemas/redeemable-earnings";
import { users } from "../../../db/schemas/users";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;
let service: typeof import("../influencer-marketplace").influencerMarketplaceService;

let seq = 0;
const uniq = (p: string) => `${p}-${(seq += 1)}-${Math.random().toString(36).slice(2, 8)}`;

async function seedOrgUser(balance = "0") {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "O", slug: uniq("o"), credit_balance: balance })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("u"), organization_id: org.id })
    .returning();
  return { orgId: org.id, userId: user.id };
}

async function orgBalance(orgId: string): Promise<number> {
  const [row] = await dbWrite
    .select({ b: organizations.credit_balance })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return Number(row?.b ?? 0);
}
async function earnings(userId: string): Promise<number> {
  const row = await dbWrite.query.redeemableEarnings.findFirst({
    where: eq(redeemableEarnings.user_id, userId),
  });
  return Number(row?.available_balance ?? 0);
}

async function seedProfile() {
  const inf = await seedOrgUser();
  const profile = await service.createProfile({
    userId: inf.userId,
    organizationId: inf.orgId,
    displayName: "Creator",
    niche: "tech",
  });
  return { ...inf, profileId: profile.id };
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    ({ influencerMarketplaceService: service } = await import("../influencer-marketplace"));
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        influencerProfiles,
        influencerBookings,
        creditTransactions,
        redeemableEarnings,
        redeemableEarningsLedger,
        redeemedEarningsTracking,
        earningsSourceEnum,
        ledgerEntryTypeEnum,
      } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error("[influencer-marketplace.test] PGlite/pushSchema unavailable — skipping.", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("Influencer marketplace escrow (#10687)", () => {
  test("pglite applied (loud)", () => {
    expect(pgliteReady).toBe(true);
  });

  test("happy path: fund → accept → deliver → approve releases escrow to the influencer", async () => {
    if (!pgliteReady) return;
    const adv = await seedOrgUser("100.00");
    const inf = await seedProfile();

    const created = await service.createBooking({
      advertiserOrgId: adv.orgId,
      profileId: inf.profileId,
      brief: "one post",
      amount: 25,
      createdByUserId: adv.userId,
    });
    expect(created.ok).toBe(true);
    expect(await orgBalance(adv.orgId)).toBeCloseTo(75, 2); // debited into escrow

    const id = created.booking!.id;
    expect((await service.acceptBooking(id, inf.userId)).ok).toBe(true);
    expect((await service.submitDeliverable(id, inf.userId, "https://x/post")).ok).toBe(true);
    expect((await service.approveBooking(id, adv.orgId)).ok).toBe(true);

    // Influencer paid; advertiser stays debited (escrow released, not refunded).
    expect(await earnings(inf.userId)).toBeCloseTo(25, 2);
    expect(await orgBalance(adv.orgId)).toBeCloseTo(75, 2);
    expect((await service.getBooking(id))?.status).toBe("approved");
  });

  test("double-approve pays the influencer exactly once (CAS gate)", async () => {
    if (!pgliteReady) return;
    const adv = await seedOrgUser("100.00");
    const inf = await seedProfile();
    const { booking } = await service.createBooking({
      advertiserOrgId: adv.orgId,
      profileId: inf.profileId,
      brief: "b",
      amount: 10,
      createdByUserId: adv.userId,
    });
    const id = booking!.id;
    await service.acceptBooking(id, inf.userId);
    await service.submitDeliverable(id, inf.userId, "https://x");
    expect((await service.approveBooking(id, adv.orgId)).ok).toBe(true);
    // Second approve finds status 'approved', matches 0 rows → no second payout.
    expect((await service.approveBooking(id, adv.orgId)).ok).toBe(false);
    expect(await earnings(inf.userId)).toBeCloseTo(10, 2);
  });

  test("rejecting an offer refunds the advertiser", async () => {
    if (!pgliteReady) return;
    const adv = await seedOrgUser("50.00");
    const inf = await seedProfile();
    const { booking } = await service.createBooking({
      advertiserOrgId: adv.orgId,
      profileId: inf.profileId,
      brief: "b",
      amount: 20,
      createdByUserId: adv.userId,
    });
    expect(await orgBalance(adv.orgId)).toBeCloseTo(30, 2);
    expect((await service.rejectBooking(booking!.id, inf.userId)).ok).toBe(true);
    expect(await orgBalance(adv.orgId)).toBeCloseTo(50, 2); // refunded
    expect(await earnings(inf.userId)).toBe(0);
  });

  test("cancelling before acceptance refunds the advertiser", async () => {
    if (!pgliteReady) return;
    const adv = await seedOrgUser("50.00");
    const inf = await seedProfile();
    const { booking } = await service.createBooking({
      advertiserOrgId: adv.orgId,
      profileId: inf.profileId,
      brief: "b",
      amount: 15,
      createdByUserId: adv.userId,
    });
    expect((await service.cancelBooking(booking!.id, adv.orgId)).ok).toBe(true);
    expect(await orgBalance(adv.orgId)).toBeCloseTo(50, 2);
    // cannot cancel again / after resolution
    expect((await service.cancelBooking(booking!.id, adv.orgId)).ok).toBe(false);
  });

  test("insufficient advertiser credits → no booking, no money moved", async () => {
    if (!pgliteReady) return;
    const adv = await seedOrgUser("5.00");
    const inf = await seedProfile();
    const res = await service.createBooking({
      advertiserOrgId: adv.orgId,
      profileId: inf.profileId,
      brief: "b",
      amount: 100,
      createdByUserId: adv.userId,
    });
    expect(res.ok).toBe(false);
    expect(await orgBalance(adv.orgId)).toBeCloseTo(5, 2);
  });

  test("cannot book your own profile", async () => {
    if (!pgliteReady) return;
    const inf = await seedProfile();
    // fund the influencer's own org so the failure is the self-book guard, not credits
    await dbWrite.update(organizations).set({ credit_balance: "100.00" }).where(eq(organizations.id, inf.orgId));
    const res = await service.createBooking({
      advertiserOrgId: inf.orgId,
      profileId: inf.profileId,
      brief: "b",
      amount: 10,
      createdByUserId: inf.userId,
    });
    expect(res.ok).toBe(false);
  });
});
