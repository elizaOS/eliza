/**
 * Reconcile double-refund mint — REAL path (#11512).
 *
 * On the monetized-app inference path (`/v1/chat/completions`, `/v1/messages`)
 * `AppCreditsService.reconcileCredits` COMMITS the org refund before its
 * throw-prone post-refund writes (`reverseCreatorEarnings`, the apps-counter
 * update). The settler (`createCreditReservationSettler`) used to reset its
 * once-guard on throw, so the route's multi-site fallback
 * `settleReservation?.(0)` re-invoked reconcile after such a mid-reconcile
 * throw and issued a SECOND committed refund — org credited
 * ≈ 2×reserved − actual, i.e. minted, cashable credit.
 *
 * These tests drive the CHANGED code end-to-end against in-process PGlite:
 * a real reservation (`reserveInferenceCredits` → org debit), a real reconcile
 * (org refund/charge rows in `credit_transactions`, creator-earnings ledger,
 * apps counters), with the only fault injection being a dependency DB blip
 * (`redeemableEarningsService.reduceEarnings` throwing once — the post-refund
 * write). Both fix layers are proven:
 *   (B) the settler never re-invokes reconcile after a rejection, and
 *   (A) even a re-invoked reconcile (any other retry vector) dedupes its
 *       org refund/charge on the synthetic `reconcile-refund:`/
 *       `reconcile-charge:` stripe_payment_intent_id key (unique index).
 *
 * The synthetic key is derived from the SERVER-GENERATED reservation deduct
 * transaction id (credit_transactions.id) — NEVER a client-controlled value
 * (Idempotency-Key header / metadata.idempotencyKey / x-request-id). The
 * stripe_payment_intent_id unique index is GLOBAL, not org-scoped, so a
 * client-controlled key would let Org A and Org B sending the SAME key
 * cross-dedupe: Org B silently loses a legit refund, or its overage charge
 * is silently skipped. The cross-tenant tests below pin that down.
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
import { runWithRequestContext } from "../../runtime/request-context";
import { createCreditReservationSettler } from "../../utils/credit-reservation";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;
let appCreditsService: typeof import("../app-credits").appCreditsService;
let redeemableEarningsService: typeof import("../redeemable-earnings").redeemableEarningsService;

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

async function orgTransactions(
  orgId: string,
  type: "refund" | "debit",
): Promise<(typeof creditTransactions.$inferSelect)[]> {
  return dbWrite
    .select()
    .from(creditTransactions)
    .where(and(eq(creditTransactions.organization_id, orgId), eq(creditTransactions.type, type)));
}

/**
 * Make the NEXT `reduceEarnings` call throw (the post-refund write blip that
 * strands reconcile mid-flight); later calls run the real implementation.
 * Returns a call counter + restore.
 */
function injectReduceEarningsBlipOnce(): { calls: () => number; restore: () => void } {
  const original = redeemableEarningsService.reduceEarnings.bind(redeemableEarningsService);
  let calls = 0;
  redeemableEarningsService.reduceEarnings = (async (params: Parameters<typeof original>[0]) => {
    calls += 1;
    if (calls === 1) {
      throw new Error("injected post-refund write blip");
    }
    return original(params);
  }) as typeof original;
  return {
    calls: () => calls,
    restore: () => {
      redeemableEarningsService.reduceEarnings = original;
    },
  };
}

beforeAll(async () => {
  try {
    ({ appCreditsService } = await import("../app-credits"));
    ({ redeemableEarningsService } = await import("../redeemable-earnings"));
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
      "[app-credits-reconcile-double-refund.test] PGlite/pushSchema unavailable — skipping.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("reconcile refund-then-throw + settler re-invoke (#11512)", () => {
  test("pglite applied (loud, never silent no-op)", () => {
    expect(pgliteReady).toBe(true);
  });

  test("settler fallback after mid-reconcile throw applies exactly ONE refund (no mint)", async () => {
    if (!pgliteReady) return;
    const { appId, payerUserId, payerOrgId, creatorUserId } = await seed();

    // The route shape: reserve the estimate, wrap the reservation in the
    // shared settler, settle from multiple sites.
    const reservation = await appCreditsService.reserveInferenceCredits({
      appId,
      userId: payerUserId,
      estimatedBaseCost: 0.03,
      description: "inference",
      idempotencyKey: "req-11512-settler",
    });
    // 100% markup: reserve debits 2×0.03 = 0.06; creator earns 0.03 upfront.
    expect(await orgBalance(payerOrgId)).toBeCloseTo(INITIAL_ORG_BALANCE - 0.06, 6);
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.03, 6);

    const settle = createCreditReservationSettler(reservation);

    const blip = injectReduceEarningsBlipOnce();
    try {
      // First settle: actual 0.01 < estimate 0.03 → refund branch. The org
      // refund of 0.04 COMMITS, then the post-refund write throws.
      await expect(settle(0.01)).rejects.toThrow("injected post-refund write blip");
      expect(await orgBalance(payerOrgId)).toBeCloseTo(INITIAL_ORG_BALANCE - 0.06 + 0.04, 6);

      // The route's fallback catch: `await settleReservation?.(0)`. Before the
      // fix this re-invoked reconcile(0) and issued a SECOND committed refund
      // (0.06 — the full reservation), leaving the org at 100.04 > 100:
      // minted, cashable credit. Now it re-awaits the same rejection.
      await expect(settle(0)).rejects.toThrow("injected post-refund write blip");
      // …and a third pile-on call (onAbort/onError racing) is just as inert.
      await expect(settle(0)).rejects.toThrow("injected post-refund write blip");
    } finally {
      blip.restore();
    }

    // reconcile ran exactly once: one post-refund write attempt, no re-invoke.
    expect(blip.calls()).toBe(1);

    // Exactly ONE refund applied — balance is the single-refund amount, not
    // the minted 2× (100 − 0.06 + 0.04 = 99.98; the mint would be 100.04).
    expect(await orgBalance(payerOrgId)).toBeCloseTo(99.98, 6);
    const refunds = await orgTransactions(payerOrgId, "refund");
    expect(refunds).toHaveLength(1);
    // Keyed on the SERVER-generated reservation txid, not the client key.
    expect(reservation.reservationTransactionId).toBeTruthy();
    expect(refunds[0]?.stripe_payment_intent_id).toBe(
      `reconcile-refund:${reservation.reservationTransactionId}`,
    );

    // Creator earnings were NOT double-reversed: the (single) reversal attempt
    // threw before applying, so the deduct-time 0.03 stands untouched.
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.03, 6);
  });

  test("re-invoked reconcile after the throw dedupes the refund and completes the reversal", async () => {
    if (!pgliteReady) return;
    const { appId, payerUserId, payerOrgId, creatorUserId } = await seed();

    const reservation = await appCreditsService.reserveInferenceCredits({
      appId,
      userId: payerUserId,
      estimatedBaseCost: 0.03,
      description: "inference",
      idempotencyKey: "req-11512-retry",
    });

    const blip = injectReduceEarningsBlipOnce();
    try {
      // First reconcile: refund commits (0.04), post-refund write throws.
      await expect(reservation.reconcile(0.01)).rejects.toThrow("injected post-refund write blip");

      // A DIRECT re-invoke (any non-settler retry vector). Layer A: the org
      // refund dedupes on the `reconcile-refund:` key — no second credit —
      // while the creator reversal now completes.
      const retried = await reservation.reconcile(0.01);
      expect(retried.adjustmentType).toBe("refund");
    } finally {
      blip.restore();
    }
    expect(blip.calls()).toBe(2);

    // Org: 100 − 0.06 + 0.04, refunded exactly once across both invocations.
    expect(await orgBalance(payerOrgId)).toBeCloseTo(99.98, 6);
    expect(await orgTransactions(payerOrgId, "refund")).toHaveLength(1);

    // Creator: 0.03 deduct-time credit − 0.02 reversal, applied exactly once.
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.01, 6);
  });

  test("reconcile refund replay (no fault) refunds the org exactly once — keyed on the reservation txid", async () => {
    if (!pgliteReady) return;
    const { appId, payerUserId, payerOrgId } = await seed();

    const deduction = await appCreditsService.deductCredits({
      appId,
      userId: payerUserId,
      baseCost: 0.03,
      description: "inference (estimate)",
    });
    const reservationTxId = deduction.transactionId;
    expect(reservationTxId).toBeTruthy();

    // Direct-reconcile shape with the deduct row's SERVER-generated
    // transaction id threaded through (as reserveInferenceCredits does).
    const runReconcile = () =>
      appCreditsService.reconcileCredits({
        appId,
        userId: payerUserId,
        estimatedBaseCost: 0.03,
        actualBaseCost: 0.01,
        description: "inference (reconcile refund)",
        reservationTransactionId: reservationTxId,
      });

    await runReconcile();
    expect(await orgBalance(payerOrgId)).toBeCloseTo(99.98, 6);

    // Full settlement replay of the SAME reservation: the refund must dedupe
    // (before #11512 the org was credited 0.04 again → 100.02).
    await runReconcile();
    expect(await orgBalance(payerOrgId)).toBeCloseTo(99.98, 6);
    const refunds = await orgTransactions(payerOrgId, "refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.stripe_payment_intent_id).toBe(`reconcile-refund:${reservationTxId}`);
  });

  test("client-controlled keys (metadata.idempotencyKey / ALS request key) never become the dedup key", async () => {
    if (!pgliteReady) return;
    const { appId, payerUserId, payerOrgId } = await seed();

    // A reconcile that carries ONLY client-controlled identifiers — the
    // Idempotency-Key echoed into metadata AND the request-ALS key — must not
    // mint a synthetic stripe_payment_intent_id from either of them: that
    // unique index is GLOBAL, so a client key would collide across orgs
    // (see the cross-tenant tests below for the resulting money loss).
    await runWithRequestContext({ idempotencyKey: "client-chosen-key" }, async () => {
      await appCreditsService.deductCredits({
        appId,
        userId: payerUserId,
        baseCost: 0.03,
        description: "inference (estimate)",
        metadata: { idempotencyKey: "client-chosen-key" },
      });
      await appCreditsService.reconcileCredits({
        appId,
        userId: payerUserId,
        estimatedBaseCost: 0.03,
        actualBaseCost: 0.01,
        description: "inference (reconcile refund)",
        metadata: { idempotencyKey: "client-chosen-key" },
      });
    });

    expect(await orgBalance(payerOrgId)).toBeCloseTo(99.98, 6);
    const refunds = await orgTransactions(payerOrgId, "refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.stripe_payment_intent_id).toBeNull();
  });

  test("overage-charge replay debits the org exactly once (symmetric key)", async () => {
    if (!pgliteReady) return;
    const { appId, payerUserId, payerOrgId } = await seed();

    const deduction = await appCreditsService.deductCredits({
      appId,
      userId: payerUserId,
      baseCost: 0.01,
      description: "inference (estimate)",
    });
    const reservationTxId = deduction.transactionId;
    expect(reservationTxId).toBeTruthy();

    const reconcileOverage = () =>
      appCreditsService.reconcileCredits({
        appId,
        userId: payerUserId,
        estimatedBaseCost: 0.01,
        actualBaseCost: 0.03,
        description: "inference (reconcile overage)",
        reservationTransactionId: reservationTxId,
      });

    // 100 − 0.02 (estimate) − 0.04 (overage) = 99.94.
    await reconcileOverage();
    expect(await orgBalance(payerOrgId)).toBeCloseTo(99.94, 6);

    // Replay: the overage charge dedupes — the org is NOT debited again.
    await reconcileOverage();
    expect(await orgBalance(payerOrgId)).toBeCloseTo(99.94, 6);
    const overageRows = (await orgTransactions(payerOrgId, "debit")).filter(
      (row) => row.stripe_payment_intent_id === `reconcile-charge:${reservationTxId}`,
    );
    expect(overageRows).toHaveLength(1);
  });
});

describe("cross-tenant isolation: shared client Idempotency-Key (#11512 revision)", () => {
  /**
   * Two DIFFERENT orgs send the SAME client Idempotency-Key (trivially
   * attacker-chosen, or a shared/misconfigured proxy echoing one
   * x-request-id). Because credit_transactions.stripe_payment_intent_id is a
   * GLOBAL unique index, keying the reconcile legs on any client-derived
   * value made Org B's refund dedupe against Org A's row (Org B loses its
   * refund) and Org B's overage charge silently skip (platform loses
   * revenue). Keyed on the server-generated reservation txid, each org's
   * settlement is independent.
   */
  const SHARED_CLIENT_KEY = "shared-proxy-idempotency-key";

  test("both orgs get their own reconcile REFUND — no cross-dedup", async () => {
    if (!pgliteReady) return;
    const tenantA = await seed();
    const tenantB = await seed();

    const reserveAndSettle = async (tenant: Awaited<ReturnType<typeof seed>>) =>
      runWithRequestContext({ idempotencyKey: SHARED_CLIENT_KEY }, async () => {
        const reservation = await appCreditsService.reserveInferenceCredits({
          appId: tenant.appId,
          userId: tenant.payerUserId,
          estimatedBaseCost: 0.03,
          description: "inference",
          idempotencyKey: SHARED_CLIENT_KEY,
        });
        const settle = createCreditReservationSettler(reservation);
        const result = await settle(0.01);
        expect(result?.adjustmentType).toBe("refund");
        return reservation;
      });

    const reservationA = await reserveAndSettle(tenantA);
    const reservationB = await reserveAndSettle(tenantB);
    expect(reservationA.reservationTransactionId).toBeTruthy();
    expect(reservationB.reservationTransactionId).toBeTruthy();
    expect(reservationA.reservationTransactionId).not.toBe(reservationB.reservationTransactionId);

    // BOTH orgs land on their own single-refund balance:
    // 100 − 0.06 (reserve) + 0.04 (refund) = 99.98. With client-key keying,
    // Org B's refund deduped against Org A's row → Org B stuck at 99.94
    // (its legit refund silently lost).
    expect(await orgBalance(tenantA.payerOrgId)).toBeCloseTo(99.98, 6);
    expect(await orgBalance(tenantB.payerOrgId)).toBeCloseTo(99.98, 6);

    const refundsA = await orgTransactions(tenantA.payerOrgId, "refund");
    const refundsB = await orgTransactions(tenantB.payerOrgId, "refund");
    expect(refundsA).toHaveLength(1);
    expect(refundsB).toHaveLength(1);
    expect(refundsA[0]?.stripe_payment_intent_id).toBe(
      `reconcile-refund:${reservationA.reservationTransactionId}`,
    );
    expect(refundsB[0]?.stripe_payment_intent_id).toBe(
      `reconcile-refund:${reservationB.reservationTransactionId}`,
    );

    // Layer A intact per reservation: a re-settle of Org B's SAME
    // reservation still dedupes (no second refund).
    await reservationB.reconcile(0.01);
    expect(await orgBalance(tenantB.payerOrgId)).toBeCloseTo(99.98, 6);
    expect(await orgTransactions(tenantB.payerOrgId, "refund")).toHaveLength(1);
  });

  test("both orgs are charged their own reconcile OVERAGE — no cross-skip", async () => {
    if (!pgliteReady) return;
    const tenantA = await seed();
    const tenantB = await seed();

    const reserveAndSettle = async (tenant: Awaited<ReturnType<typeof seed>>) =>
      runWithRequestContext({ idempotencyKey: SHARED_CLIENT_KEY }, async () => {
        const reservation = await appCreditsService.reserveInferenceCredits({
          appId: tenant.appId,
          userId: tenant.payerUserId,
          estimatedBaseCost: 0.01,
          description: "inference",
          idempotencyKey: SHARED_CLIENT_KEY,
        });
        const settle = createCreditReservationSettler(reservation);
        const result = await settle(0.03);
        expect(result?.adjustmentType).toBe("overage");
        return reservation;
      });

    const reservationA = await reserveAndSettle(tenantA);
    const reservationB = await reserveAndSettle(tenantB);

    // BOTH orgs pay their own overage: 100 − 0.02 (reserve) − 0.04 (overage)
    // = 99.94. With client-key keying, Org B's charge deduped against Org A's
    // row → Org B kept 99.98 (the platform silently lost the overage).
    expect(await orgBalance(tenantA.payerOrgId)).toBeCloseTo(99.94, 6);
    expect(await orgBalance(tenantB.payerOrgId)).toBeCloseTo(99.94, 6);

    const chargeA = (await orgTransactions(tenantA.payerOrgId, "debit")).filter(
      (row) =>
        row.stripe_payment_intent_id ===
        `reconcile-charge:${reservationA.reservationTransactionId}`,
    );
    const chargeB = (await orgTransactions(tenantB.payerOrgId, "debit")).filter(
      (row) =>
        row.stripe_payment_intent_id ===
        `reconcile-charge:${reservationB.reservationTransactionId}`,
    );
    expect(chargeA).toHaveLength(1);
    expect(chargeB).toHaveLength(1);
  });
});
