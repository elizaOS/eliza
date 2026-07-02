/**
 * Influencer marketplace escrow (#10687) — real Drizzle schema, in-process PGlite.
 *
 * Drives the money-critical booking lifecycle: funding debits the advertiser's
 * org credits, approval releases the escrow to the influencer's redeemable
 * earnings, and rejection/cancel refunds the advertiser. Every money move is
 * idempotent on the booking id and runs BEFORE the status finalize (CAS), so
 * failures leave a retryable state and a retry moves money at most once —
 * including the failure-mode paths (payout outage, refund outage, funding
 * crash windows, client create retries) exercised below.
 *
 * Fails loudly (via the `pgliteReady` guard) if PGlite/pushSchema ever fails to initialize — never a silent skip.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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
import { creditTransactions } from "../../../db/schemas/credit-transactions";
import { influencerBookings, influencerProfiles } from "../../../db/schemas/influencer-marketplace";
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
let creditsService: typeof import("../credits").creditsService;
let redeemableEarningsService: typeof import("../redeemable-earnings").redeemableEarningsService;

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
  try {
    ({ influencerMarketplaceService: service } = await import("../influencer-marketplace"));
    ({ creditsService } = await import("../credits"));
    ({ redeemableEarningsService } = await import("../redeemable-earnings"));
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
    // no funding-limbo row is left behind
    const rows = await dbWrite
      .select()
      .from(influencerBookings)
      .where(eq(influencerBookings.advertiser_org_id, adv.orgId));
    expect(rows.length).toBe(0);
  });

  test("fund is booking-row-first with a keyed debit: same-key retry returns the same booking and debits once", async () => {
    if (!pgliteReady) return;
    const adv = await seedOrgUser("100.00");
    const inf = await seedProfile();
    const key = uniq("create-key");

    const first = await service.createBooking({
      advertiserOrgId: adv.orgId,
      profileId: inf.profileId,
      brief: "one post",
      amount: 25,
      createdByUserId: adv.userId,
      idempotencyKey: key,
    });
    expect(first.ok).toBe(true);
    expect(first.booking?.status).toBe("offered");
    expect(await orgBalance(adv.orgId)).toBeCloseTo(75, 2);

    // The escrow debit is keyed on the booking id and linked on the row.
    const debits = await dbWrite
      .select()
      .from(creditTransactions)
      .where(
        eq(creditTransactions.stripe_payment_intent_id, `influencer_fund_${first.booking?.id}`),
      );
    expect(debits.length).toBe(1);
    expect(first.booking?.escrow_transaction_id).toBe(debits[0].id);

    // A lost-response client retry with the same key returns the ORIGINAL
    // booking and moves no more money.
    const retry = await service.createBooking({
      advertiserOrgId: adv.orgId,
      profileId: inf.profileId,
      brief: "one post",
      amount: 25,
      createdByUserId: adv.userId,
      idempotencyKey: key,
    });
    expect(retry.ok).toBe(true);
    expect(retry.booking?.id).toBe(first.booking?.id);
    expect(await orgBalance(adv.orgId)).toBeCloseTo(75, 2); // debited exactly once
  });

  test("funding resume: crash between keyed debit and finalize is repaired by a same-key retry without a second debit", async () => {
    if (!pgliteReady) return;
    const adv = await seedOrgUser("40.00");
    const inf = await seedProfile();
    const key = uniq("resume-key");

    // Simulate the crash window: the booking row exists in `funding` and the
    // keyed escrow debit committed, but the finalize CAS never ran.
    const [row] = await dbWrite
      .insert(influencerBookings)
      .values({
        advertiser_org_id: adv.orgId,
        influencer_profile_id: inf.profileId,
        influencer_user_id: inf.userId,
        brief: "b",
        amount: "10.00",
        status: "funding",
        created_by_user_id: adv.userId,
        idempotency_key: key,
      })
      .returning();
    await creditsService.deductCredits({
      organizationId: adv.orgId,
      amount: 10,
      description: "Influencer booking escrow (Creator)",
      stripePaymentIntentId: `influencer_fund_${row.id}`,
    });
    expect(await orgBalance(adv.orgId)).toBeCloseTo(30, 2);

    const retry = await service.createBooking({
      advertiserOrgId: adv.orgId,
      profileId: inf.profileId,
      brief: "b",
      amount: 10,
      createdByUserId: adv.userId,
      idempotencyKey: key,
    });
    expect(retry.ok).toBe(true);
    expect(retry.booking?.id).toBe(row.id);
    expect(retry.booking?.status).toBe("offered");
    expect(await orgBalance(adv.orgId)).toBeCloseTo(30, 2); // still exactly one debit
  });

  test("payout failure leaves the booking delivered; retry pays exactly once", async () => {
    if (!pgliteReady) return;
    const adv = await seedOrgUser("100.00");
    const inf = await seedProfile();
    const { booking } = await service.createBooking({
      advertiserOrgId: adv.orgId,
      profileId: inf.profileId,
      brief: "b",
      amount: 25,
      createdByUserId: adv.userId,
    });
    const id = booking?.id as string;
    await service.acceptBooking(id, inf.userId);
    await service.submitDeliverable(id, inf.userId, "https://x/post");

    const originalAddEarnings =
      redeemableEarningsService.addEarnings.bind(redeemableEarningsService);
    redeemableEarningsService.addEarnings = async () => ({
      success: false,
      newBalance: 0,
      ledgerEntryId: "",
      error: "simulated payout outage",
    });
    try {
      // Payout fails → approve MUST NOT report success or move the status.
      const failed = await service.approveBooking(id, adv.orgId);
      expect(failed.ok).toBe(false);
      expect((await service.getBooking(id))?.status).toBe("delivered");
      expect(await earnings(inf.userId)).toBe(0);
    } finally {
      redeemableEarningsService.addEarnings = originalAddEarnings;
    }

    // Retry succeeds and pays exactly once.
    const retried = await service.approveBooking(id, adv.orgId);
    expect(retried.ok).toBe(true);
    expect((await service.getBooking(id))?.status).toBe("approved");
    expect(await earnings(inf.userId)).toBeCloseTo(25, 2);

    // A further retry cannot double-pay.
    expect((await service.approveBooking(id, adv.orgId)).ok).toBe(false);
    expect(await earnings(inf.userId)).toBeCloseTo(25, 2);
  });

  test("refund failure leaves the prior status; retry refunds exactly once", async () => {
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
    const id = booking?.id as string;
    expect(await orgBalance(adv.orgId)).toBeCloseTo(30, 2);

    const originalRefund = creditsService.refundCredits.bind(creditsService);
    creditsService.refundCredits = async () => {
      throw new Error("simulated refund outage");
    };
    try {
      // Refund fails → the booking MUST NOT be marked rejected.
      const failed = await service.rejectBooking(id, inf.userId);
      expect(failed.ok).toBe(false);
      expect((await service.getBooking(id))?.status).toBe("offered");
      expect(await orgBalance(adv.orgId)).toBeCloseTo(30, 2);
    } finally {
      creditsService.refundCredits = originalRefund;
    }

    // Retry refunds exactly once and finalizes the status.
    const retried = await service.rejectBooking(id, inf.userId);
    expect(retried.ok).toBe(true);
    expect((await service.getBooking(id))?.status).toBe("rejected");
    expect(await orgBalance(adv.orgId)).toBeCloseTo(50, 2);
    const refunds = await dbWrite
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.stripe_payment_intent_id, `influencer_refund_${id}`));
    expect(refunds.length).toBe(1);

    // A further reject cannot refund twice.
    expect((await service.rejectBooking(id, inf.userId)).ok).toBe(false);
    expect(await orgBalance(adv.orgId)).toBeCloseTo(50, 2);
  });

  test("influencer can decline an accepted booking — advertiser refunded (no escrow lock-forever)", async () => {
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
    const id = booking?.id as string;
    expect((await service.acceptBooking(id, inf.userId)).ok).toBe(true);

    const declined = await service.rejectBooking(id, inf.userId);
    expect(declined.ok).toBe(true);
    expect((await service.getBooking(id))?.status).toBe("rejected");
    expect(await orgBalance(adv.orgId)).toBeCloseTo(50, 2); // refunded
    expect(await earnings(inf.userId)).toBe(0);

    // Repeat decline cannot refund twice.
    expect((await service.rejectBooking(id, inf.userId)).ok).toBe(false);
    expect(await orgBalance(adv.orgId)).toBeCloseTo(50, 2);
  });

  test("cannot book your own profile", async () => {
    if (!pgliteReady) return;
    const inf = await seedProfile();
    // fund the influencer's own org so the failure is the self-book guard, not credits
    await dbWrite
      .update(organizations)
      .set({ credit_balance: "100.00" })
      .where(eq(organizations.id, inf.orgId));
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
