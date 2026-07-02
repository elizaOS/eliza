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

  test("payout failure leaves the booking approving; retry pays exactly once", async () => {
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
      // Payout fails after the fork was claimed → approve MUST NOT report
      // success or pay; the booking rests in `approving` for the same operation
      // to resume (the claim CAS already fenced out a concurrent reject). (#11116)
      const failed = await service.approveBooking(id, adv.orgId);
      expect(failed.ok).toBe(false);
      expect((await service.getBooking(id))?.status).toBe("approving");
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

  test("refund failure leaves the claimed `refunding` status; retry resumes and refunds exactly once", async () => {
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
      // Refund fails AFTER the claim → the booking MUST NOT be marked rejected;
      // it rests in `refunding` (the claim fences out deliver/approve) so the
      // same operation can resume. (#11167)
      const failed = await service.rejectBooking(id, inf.userId);
      expect(failed.ok).toBe(false);
      expect((await service.getBooking(id))?.status).toBe("refunding");
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

  // #11116 — the `delivered` money fork must never both pay the influencer AND
  // refund the advertiser for one escrow. Before the CAS-claim fix, approve and
  // rejectDeliverable each read `delivered` and moved money before their status
  // CAS, under different idempotency keys, so a concurrent pair double-spent.
  // Promise.all on single-connection PGlite interleaves the two methods' awaits
  // (both reads land before either finalize), reproducing the race; the claim
  // CAS (`delivered → approving`/`refunding`) now lets exactly one win.
  test("concurrent approve + rejectDeliverable on a delivered booking moves money exactly once (#11116)", async () => {
    if (!pgliteReady) return;
    const adv = await seedOrgUser("100.00");
    const inf = await seedProfile();
    const { booking } = await service.createBooking({
      advertiserOrgId: adv.orgId,
      profileId: inf.profileId,
      brief: "b",
      amount: 40,
      createdByUserId: adv.userId,
    });
    const id = booking?.id as string;
    await service.acceptBooking(id, inf.userId);
    await service.submitDeliverable(id, inf.userId, "https://x/post");
    // Escrow funded: advertiser debited 40 → 60; nothing paid/refunded yet.
    expect(await orgBalance(adv.orgId)).toBeCloseTo(60, 2);
    expect(await earnings(inf.userId)).toBe(0);

    const [approve, reject] = await Promise.all([
      service.approveBooking(id, adv.orgId),
      service.rejectDeliverable(id, adv.orgId),
    ]);

    // Exactly one exit succeeds; the other is refused.
    expect([approve.ok, reject.ok].filter(Boolean).length).toBe(1);

    const paid = await earnings(inf.userId); // influencer payout (0 or 40)
    const bal = await orgBalance(adv.orgId); // advertiser (60 held, or 100 refunded)
    const refunded = bal >= 99.99; // refund returned the 40

    // The invariant: NEVER both. Either influencer paid (40) and advertiser
    // stays at 60, or advertiser refunded (100) and influencer paid 0.
    expect(paid > 0 && refunded).toBe(false);
    if (approve.ok) {
      expect(paid).toBeCloseTo(40, 2);
      expect(bal).toBeCloseTo(60, 2);
      expect((await service.getBooking(id))?.status).toBe("approved");
    } else {
      expect(paid).toBe(0);
      expect(bal).toBeCloseTo(100, 2);
      expect((await service.getBooking(id))?.status).toBe("rejected");
    }
  });

  test("a booking mid-approve (approving) cannot be refunded by reject (#11116)", async () => {
    if (!pgliteReady) return;
    const adv = await seedOrgUser("100.00");
    const inf = await seedProfile();
    const { booking } = await service.createBooking({
      advertiserOrgId: adv.orgId,
      profileId: inf.profileId,
      brief: "b",
      amount: 30,
      createdByUserId: adv.userId,
    });
    const id = booking?.id as string;
    await service.acceptBooking(id, inf.userId);
    await service.submitDeliverable(id, inf.userId, "https://x/post");
    // Simulate an approve that claimed the fork but hasn't finished paying.
    await dbWrite
      .update(influencerBookings)
      .set({ status: "approving" })
      .where(eq(influencerBookings.id, id));

    const rejected = await service.rejectDeliverable(id, adv.orgId);
    expect(rejected.ok).toBe(false);
    expect(await orgBalance(adv.orgId)).toBeCloseTo(70, 2); // escrow still held, no refund
    // The rightful owner can still resume the approval and get paid once.
    const resumed = await service.approveBooking(id, adv.orgId);
    expect(resumed.ok).toBe(true);
    expect(await earnings(inf.userId)).toBeCloseTo(30, 2);
    expect(await orgBalance(adv.orgId)).toBeCloseTo(70, 2);
  });

  // #11167 — the GENERIC refund (offer/accept fork) must claim the booking
  // before moving money, exactly like the #11116 `delivered` fork. Before the
  // claim, refund() was refund-then-CAS: it read `accepted`, committed the
  // refund, and only then CAS'd the status — so during its read→refund gap a
  // concurrent deliver + approve could pay the influencer out of the SAME
  // escrow (advertiser refunded AND influencer paid). The gated refundCredits
  // below deterministically parks the reject inside that gap while the
  // deliver + approve race in; the claim CAS (`accepted → refunding`) now
  // fences them out before any money moves.
  test("generic refund from accepted cannot double-spend vs racing deliver+approve (#11167)", async () => {
    if (!pgliteReady) return;
    const adv = await seedOrgUser("100.00");
    const inf = await seedProfile();
    const { booking } = await service.createBooking({
      advertiserOrgId: adv.orgId,
      profileId: inf.profileId,
      brief: "b",
      amount: 40,
      createdByUserId: adv.userId,
    });
    const id = booking?.id as string;
    await service.acceptBooking(id, inf.userId);
    // Escrow funded: advertiser debited 40 → 60; nothing paid/refunded yet.
    expect(await orgBalance(adv.orgId)).toBeCloseTo(60, 2);
    expect(await earnings(inf.userId)).toBe(0);

    // Park the FIRST refundCredits call on a manual gate: the reject has done
    // its read (+claim, with the fix) but its money move is frozen mid-flight.
    const originalRefund = creditsService.refundCredits.bind(creditsService);
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let gateReached = false;
    creditsService.refundCredits = async (params) => {
      if (!gateReached) {
        gateReached = true;
        await gate;
      }
      return originalRefund(params);
    };

    const rejectPromise = service.rejectBooking(id, inf.userId);
    try {
      // Wait until the reject is actually parked at refundCredits.
      const deadline = Date.now() + 5_000;
      while (!gateReached && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(gateReached).toBe(true);

      // While the refund is in its read→money gap, race the payout path in.
      const submitted = await service.submitDeliverable(id, inf.userId, "https://x/post");
      const approved = await service.approveBooking(id, adv.orgId);

      releaseGate();
      const rejected = await rejectPromise;

      const paid = await earnings(inf.userId); // influencer payout (0 or 40)
      const bal = await orgBalance(adv.orgId); // advertiser (60 held, or 100 refunded)
      const refunded = bal >= 99.99; // refund returned the 40

      // The invariant: one escrow NEVER funds both a refund and a payout.
      expect(paid > 0 && refunded).toBe(false);

      // With the claim, the reject owns the booking: deliver/approve are
      // fenced out, the refund wins, and the advertiser is made whole.
      expect(submitted.ok).toBe(false);
      expect(approved.ok).toBe(false);
      expect(rejected.ok).toBe(true);
      expect((await service.getBooking(id))?.status).toBe("rejected");
      expect(bal).toBeCloseTo(100, 2);
      expect(paid).toBe(0);
    } finally {
      releaseGate();
      creditsService.refundCredits = originalRefund;
      await rejectPromise;
    }
  });

  // #11167 — a booking claimed `refunding` is fenced against EVERY other
  // transition: accept needs `offered`, submitDeliverable needs `accepted`,
  // approve needs `delivered`/`approving`. This is what makes deleting the old
  // force-finalize fallback safe — once the claim is won nothing can race in,
  // and a crashed claim is resumable to exactly one refund.
  test("a `refunding` claim fences out accept, deliver, and approve; the refund resumes to completion", async () => {
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
    await service.acceptBooking(id, inf.userId);
    // Simulate a reject that claimed the booking but crashed before the money
    // move (the claim-then-crash window).
    await dbWrite
      .update(influencerBookings)
      .set({ status: "refunding" })
      .where(eq(influencerBookings.id, id));

    expect((await service.acceptBooking(id, inf.userId)).ok).toBe(false);
    expect((await service.submitDeliverable(id, inf.userId, "https://x")).ok).toBe(false);
    expect((await service.approveBooking(id, adv.orgId)).ok).toBe(false);
    expect(await earnings(inf.userId)).toBe(0);
    expect(await orgBalance(adv.orgId)).toBeCloseTo(30, 2); // escrow still held

    // The influencer's reject resumes the crashed claim: refunds exactly once
    // and finalizes to its own terminal.
    const resumed = await service.rejectBooking(id, inf.userId);
    expect(resumed.ok).toBe(true);
    expect((await service.getBooking(id))?.status).toBe("rejected");
    expect(await orgBalance(adv.orgId)).toBeCloseTo(50, 2);
    const refunds = await dbWrite
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.stripe_payment_intent_id, `influencer_refund_${id}`));
    expect(refunds.length).toBe(1);

    // Terminal — no further refund path can move money again.
    expect((await service.rejectBooking(id, inf.userId)).ok).toBe(false);
    expect((await service.cancelBooking(id, adv.orgId)).ok).toBe(false);
    expect(await orgBalance(adv.orgId)).toBeCloseTo(50, 2);
  });

  // #11167 — two refund routes racing for one escrow (influencer reject vs
  // advertiser cancel, both from `offered`): one wins the claim, the other is
  // admitted as a resume of the same `refunding` claim; the keyed refund
  // dedupes, so the advertiser is refunded exactly once either way.
  test("concurrent reject + cancel on an offered booking refunds exactly once", async () => {
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

    const [rejected, cancelled] = await Promise.all([
      service.rejectBooking(id, inf.userId),
      service.cancelBooking(id, adv.orgId),
    ]);

    // At least one succeeds; a loser that resumed the winner's claim may also
    // report success — but the money can only have moved once.
    expect([rejected.ok, cancelled.ok].some(Boolean)).toBe(true);
    expect(await orgBalance(adv.orgId)).toBeCloseTo(50, 2); // refunded exactly once
    expect(await earnings(inf.userId)).toBe(0);
    const refunds = await dbWrite
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.stripe_payment_intent_id, `influencer_refund_${id}`));
    expect(refunds.length).toBe(1);
    const terminal = (await service.getBooking(id))?.status;
    expect(["rejected", "cancelled"]).toContain(terminal);
  });
});
