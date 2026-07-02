/**
 * Stale-reservation sweep vs the app-chat settle lane — REAL path (#11683,
 * hardens #11493).
 *
 * Two live money defects, both introduced by the #11493 sweep:
 *
 * 1. DOUBLE-REFUND (cashable mint): the sweep settled app-chat holds through
 *    the GENERIC reservation lane, whose refund is keyed
 *    `recon:<holdId>:refund`, while the route's late settle
 *    (`appCreditsService.reconcileCredits`) refunds under
 *    `reconcile-refund:<holdId>` (#11512). Disjoint keys ⇒ no cross-dedup.
 *    The sweep ran every minute with a 20-minute grace, but the provider HTTP
 *    retry ladder keeps a hold legitimately in flight far longer
 *    (PROVIDER_DEFAULT_MAX_RETRIES ⇒ 4 tries × ≤790s per try × 2 providers
 *    ≈ 106 min), so the sweep refunded a still-in-flight hold and the late
 *    settle refunded it AGAIN — org credited ≈ 2×reserved − actual.
 *
 * 2. MARKUP OVER-REFUND: the app-chat hold amount is the markup-INCLUSIVE
 *    totalCost and the creator's markup earnings are committed at deduct
 *    time, but the generic sweep settled against the base-only
 *    estimated_cost — refunding the buffer PLUS the whole markup to the
 *    consumer while leaving the creator's deduct-time earnings unreversed
 *    (unbacked redeemable earnings). The #11493 fixture only modeled
 *    markup = 0, so this never tripped.
 *
 * These tests drive the REAL code end-to-end against in-process PGlite:
 * a real route-shaped app-chat hold (`deductCredits` with the
 * `app_chat_reservation_v1` marker metadata, exactly as
 * `v1/apps/[id]/chat/route.ts` writes it), the real
 * `creditsService.sweepStaleReservations()`, and the real late settle
 * (`appCreditsService.reconcileCredits` with the server-generated reservation
 * transaction id — the actual settle lane, NOT the generic
 * `creditsService.reconcile` the #11493 test used, which is why the defect
 * slipped through). No mocks anywhere on the money path.
 *
 * Fails loudly (via the `pgliteReady` guard) if PGlite/pushSchema ever fails
 * to initialize — never a silent skip.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// This proof owns its DB: force an isolated in-memory PGlite regardless of the
// ambient DATABASE_URL / TEST_DATABASE_URL the CI lane exports (see
// app-credits-idempotency.test.ts for the full rationale).
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { and, eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../../db/client";
import { appEarnings, appEarningsTransactions } from "../../../db/schemas/app-earnings";
import {
  appDeploymentStatusEnum,
  appReviewStatusEnum,
  apps,
  appUsers,
  userDatabaseStatusEnum,
} from "../../../db/schemas/apps";
import { creditTransactions } from "../../../db/schemas/credit-transactions";
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
let appCreditsService: typeof import("../app-credits").appCreditsService;
let creditsService: typeof import("../credits").creditsService;
let RESERVATION_SWEEP_GRACE_MS: number;

const APP_CHAT_RESERVATION_SETTLEMENT_MARKER = "app_chat_reservation_v1";
const OLD_SWEEP_GRACE_MS = 20 * 60 * 1000;

let seq = 0;
function uniq(p: string): string {
  seq += 1;
  return `${p}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

const INITIAL_ORG_BALANCE = 100;

async function seed(): Promise<{
  appId: string;
  payerUserId: string;
  payerOrgId: string;
  creatorUserId: string;
}> {
  const [payerOrg] = await dbWrite
    .insert(organizations)
    .values({ name: "Payer", slug: uniq("payer"), credit_balance: "100.000000" })
    .returning();
  const [payer] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("payer-u"), organization_id: payerOrg.id })
    .returning();
  const [creatorOrg] = await dbWrite
    .insert(organizations)
    .values({ name: "Creator", slug: uniq("creator") })
    .returning();
  const [creator] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("creator-u"), organization_id: creatorOrg.id })
    .returning();
  const [app] = await dbWrite
    .insert(apps)
    .values({
      name: "Monetized App",
      slug: uniq("app"),
      organization_id: creatorOrg.id,
      created_by_user_id: creator.id,
      app_url: "https://placeholder.invalid",
      monetization_enabled: true,
      inference_markup_percentage: 100,
    })
    .returning();
  return {
    appId: app.id,
    payerUserId: payer.id,
    payerOrgId: payerOrg.id,
    creatorUserId: creator.id,
  };
}

/**
 * Open an app-chat hold EXACTLY as `v1/apps/[id]/chat/route.ts` does — the
 * same `deductCredits` call with the same marker metadata — then backdate the
 * hold row so the sweep's grace window logic sees the requested age.
 */
async function openRouteShapedHold(params: {
  appId: string;
  userId: string;
  estimatedBaseCost: number;
  reservedBaseCost: number;
  ageMs: number;
}): Promise<string> {
  const { appId, userId, estimatedBaseCost, reservedBaseCost, ageMs } = params;
  const deduction = await appCreditsService.deductCredits({
    appId,
    userId,
    baseCost: reservedBaseCost,
    description: "Chat: test-model",
    metadata: {
      type: "app_chat_reservation",
      settlement_marker: APP_CHAT_RESERVATION_SETTLEMENT_MARKER,
      model: "test-model",
      provider: "test-provider",
      billingSource: "test",
      estimatedInputTokens: 10,
      estimatedOutputTokens: 100,
      estimated_cost: estimatedBaseCost,
      reserved_amount: reservedBaseCost,
      safetyMultiplier: 1.5,
      reservation_buffer: 1.5,
    },
  });
  expect(deduction.success).toBe(true);
  const holdId = deduction.transactionId;
  if (!holdId) throw new Error("deductCredits returned no transaction id");
  await dbWrite
    .update(creditTransactions)
    .set({ created_at: new Date(Date.now() - ageMs) })
    .where(eq(creditTransactions.id, holdId));
  return holdId;
}

async function orgBalance(orgId: string): Promise<number> {
  const [row] = await dbWrite.select().from(organizations).where(eq(organizations.id, orgId));
  return Number(row?.credit_balance ?? Number.NaN);
}

async function creatorBalance(userId: string): Promise<number> {
  const row = await dbWrite.query.redeemableEarnings.findFirst({
    where: eq(redeemableEarnings.user_id, userId),
  });
  return Number(row?.available_balance ?? 0);
}

async function appCreatorEarningsCounter(appId: string): Promise<number> {
  const [row] = await dbWrite.select().from(apps).where(eq(apps.id, appId));
  return Number(row?.total_creator_earnings ?? Number.NaN);
}

async function refundRows(orgId: string): Promise<(typeof creditTransactions.$inferSelect)[]> {
  return dbWrite
    .select()
    .from(creditTransactions)
    .where(
      and(eq(creditTransactions.organization_id, orgId), eq(creditTransactions.type, "refund")),
    );
}

async function holdSettledAt(holdId: string): Promise<Date | null> {
  const [row] = await dbWrite
    .select()
    .from(creditTransactions)
    .where(eq(creditTransactions.id, holdId));
  return row?.settled_at ?? null;
}

beforeAll(async () => {
  try {
    ({ appCreditsService } = await import("../app-credits"));
    ({ creditsService, RESERVATION_SWEEP_GRACE_MS } = await import("../credits"));
    const schema = {
      organizations,
      users,
      apps,
      appUsers,
      appEarnings,
      appEarningsTransactions,
      redeemableEarnings,
      redeemableEarningsLedger,
      redeemedEarningsTracking,
      creditTransactions,
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
    console.error(
      "[app-chat-sweep-double-refund.test] PGlite/pushSchema unavailable — skipping.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("stale-reservation sweep vs app-chat settle lane (#11683)", () => {
  test("pglite applied (loud, never silent no-op)", () => {
    expect(pgliteReady).toBe(true);
  });

  test("default sweep grace covers the provider retry-ladder in-flight window", () => {
    // 4 tries × 790s + backoff, × 2 providers ≈ 106 min; the grace must sit
    // ABOVE it (and far above the old 20-minute value that caused the mint).
    expect(RESERVATION_SWEEP_GRACE_MS).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
    expect(RESERVATION_SWEEP_GRACE_MS).toBeGreaterThan(OLD_SWEEP_GRACE_MS);
  });

  test("a hold in-flight past the OLD 20-min grace is NOT swept; the late settle refunds exactly once", async () => {
    if (!pgliteReady) return;
    const { appId, payerUserId, payerOrgId, creatorUserId } = await seed();

    // Route shape: estimate 0.02 base, ×1.5 buffer → 0.03 reserved base;
    // 100% markup → hold debits 0.06 and the creator earns 0.03 upfront.
    const holdId = await openRouteShapedHold({
      appId,
      userId: payerUserId,
      estimatedBaseCost: 0.02,
      reservedBaseCost: 0.03,
      ageMs: 25 * 60 * 1000, // past the OLD grace, inside the retry ladder
    });
    expect(await orgBalance(payerOrgId)).toBeCloseTo(INITIAL_ORG_BALANCE - 0.06, 6);
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.03, 6);

    // DEFAULT sweep (the cron's call shape): the request is legitimately still
    // in flight — the sweep must leave the hold alone. Before this fix the
    // 20-minute default grace swept (and refunded) it here.
    await creditsService.sweepStaleReservations();
    expect(await holdSettledAt(holdId)).toBeNull();
    expect(await orgBalance(payerOrgId)).toBeCloseTo(INITIAL_ORG_BALANCE - 0.06, 6);
    expect(await refundRows(payerOrgId)).toHaveLength(0);

    // The request completes; the route settles through the REAL lane. Exactly
    // one refund: actual 0.01 base < 0.03 reserved base → 0.04 total refund.
    await appCreditsService.reconcileCredits({
      appId,
      userId: payerUserId,
      estimatedBaseCost: 0.03,
      actualBaseCost: 0.01,
      description: "late app-chat settle",
      reservationTransactionId: holdId,
    });
    expect(await orgBalance(payerOrgId)).toBeCloseTo(99.98, 6);
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.01, 6);
    const refunds = await refundRows(payerOrgId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.stripe_payment_intent_id).toBe(`reconcile-refund:${holdId}`);
    expect(await holdSettledAt(holdId)).toBeTruthy();
  });

  test("markup>0 hold: sweep settles through the app-credits lane (correct markup math + earnings reversal) and the late settle is a dedup no-op", async () => {
    if (!pgliteReady) return;
    const { appId, payerUserId, payerOrgId, creatorUserId } = await seed();

    const holdId = await openRouteShapedHold({
      appId,
      userId: payerUserId,
      estimatedBaseCost: 0.02,
      reservedBaseCost: 0.03,
      ageMs: 3 * 60 * 60 * 1000, // genuinely stranded: older than the new grace
    });
    expect(await orgBalance(payerOrgId)).toBeCloseTo(99.94, 6);
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.03, 6);
    expect(await appCreatorEarningsCounter(appId)).toBeCloseTo(0.03, 6);

    // DEFAULT sweep: assumes actual == the 0.02 base estimate and settles in
    // BASE-cost space: refund = (0.03 − 0.02) × 2 (100% markup) = 0.02, and
    // the creator's earnings are reversed by the 0.01 markup delta. The old
    // generic lane refunded |hold| − estimated_cost = 0.06 − 0.02 = 0.04
    // (over-refunding the whole markup) and reversed NOTHING.
    const stats = await creditsService.sweepStaleReservations();
    expect(stats.settled).toBe(1);
    expect(stats.refunds).toBe(1);
    expect(await orgBalance(payerOrgId)).toBeCloseTo(99.96, 6);
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.02, 6);
    expect(await appCreatorEarningsCounter(appId)).toBeCloseTo(0.02, 6);
    expect(await holdSettledAt(holdId)).toBeTruthy();
    const sweptRefunds = await refundRows(payerOrgId);
    expect(sweptRefunds).toHaveLength(1);
    // The sweep now shares the settle lane's idempotency key — this is the
    // cross-dedup that was missing (#11493 keyed it `recon:<holdId>:refund`).
    expect(sweptRefunds[0]?.stripe_payment_intent_id).toBe(`reconcile-refund:${holdId}`);

    // The provider finally answers and the route's late settle fires with the
    // REAL actual cost. Before this fix it refunded 0.04 MORE under its own
    // key (org up to 100.02 — minted, cashable credit) and double-reversed
    // nothing/earnings inconsistently. Now: full dedup no-op on the org
    // refund, the earnings reversal, and the apps counter.
    await appCreditsService.reconcileCredits({
      appId,
      userId: payerUserId,
      estimatedBaseCost: 0.03,
      actualBaseCost: 0.01,
      description: "late app-chat settle after sweep",
      reservationTransactionId: holdId,
    });
    expect(await orgBalance(payerOrgId)).toBeCloseTo(99.96, 6);
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.02, 6);
    expect(await appCreatorEarningsCounter(appId)).toBeCloseTo(0.02, 6);
    expect(await refundRows(payerOrgId)).toHaveLength(1);
  });

  test("settled-first hold: the sweep skips it (settled_at fence)", async () => {
    if (!pgliteReady) return;
    const { appId, payerUserId, payerOrgId, creatorUserId } = await seed();

    const holdId = await openRouteShapedHold({
      appId,
      userId: payerUserId,
      estimatedBaseCost: 0.02,
      reservedBaseCost: 0.03,
      ageMs: 3 * 60 * 60 * 1000,
    });

    // Settle lane wins the race: refund 0.04, creator reversed 0.02.
    await appCreditsService.reconcileCredits({
      appId,
      userId: payerUserId,
      estimatedBaseCost: 0.03,
      actualBaseCost: 0.01,
      description: "settle before sweep",
      reservationTransactionId: holdId,
    });
    expect(await orgBalance(payerOrgId)).toBeCloseTo(99.98, 6);
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.01, 6);

    // The sweep must not touch the settled hold — no second refund.
    await creditsService.sweepStaleReservations();
    expect(await orgBalance(payerOrgId)).toBeCloseTo(99.98, 6);
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.01, 6);
    expect(await refundRows(payerOrgId)).toHaveLength(1);
  });
});
