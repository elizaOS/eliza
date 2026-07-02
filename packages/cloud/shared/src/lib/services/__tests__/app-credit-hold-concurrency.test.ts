/**
 * Real-DB proof of the upfront app-credit hold (#10857, PR #10892).
 *
 * The bug: monetized `X-App-Id` inference did a read-only `checkBalance` and
 * deferred the entire charge to a post-response reconcile, so N concurrent
 * requests could all pass the advisory check and overspend the org balance
 * (platform absorbs the loss). The fix routes the estimate through
 * `appCreditsService.reserveInferenceCredits` → `deductCredits` →
 * `creditsService.reserveAndDeductCredits` — the row-locked conditional debit.
 *
 * The unit suite (`app-credits-ledger.test.ts`) pins the wiring with a mocked
 * `reserveAndDeductCredits`; it cannot prove the concurrency property. This
 * suite drives the REAL `reserveInferenceCredits` against in-process PGlite
 * (real Drizzle schema via `pushSchema`, same harness as
 * `creator-earnings-idempotency.test.ts`) with NOTHING mocked on the money
 * path, and asserts:
 *
 *   1. (ported from #10909) 8 concurrent $0.30 holds against a $1.00 balance:
 *      exactly 3 win, the surplus 5 throw InsufficientCreditsError, the balance
 *      never goes negative, and exactly 3 debit rows exist.
 *   2. Settling a winner to zero (provider failure path) refunds the full hold.
 *   3. The leg-discriminated earnings dedupe keys (`${chargeKey}:${type}:${leg}`,
 *      #10847 follow-up) mint creator earnings exactly once per movement against
 *      the REAL redeemable-earnings dedupe: the overage still pays (distinct
 *      `reconcile_charge` leg vs the `deduct` leg) and a settlement retry does
 *      not double-credit (same leg) — the property that subsumes #10873's
 *      per-request earnings dedupe.
 *   4. A $0 estimate (free/unpriced model) opens a MIN_RESERVATION floor hold
 *      instead of throwing `reserveAndDeductCredits`' "Amount must be positive"
 *      (which the routes surfaced as a 500), and reconcile trues the floor up
 *      to the actual cost in both directions.
 *
 * Fails loudly (via the `pgliteReady` guard) if PGlite/pushSchema ever fails to initialize — never a silent skip.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// This proof owns its DB: force an isolated in-memory PGlite regardless of the
// ambient DATABASE_URL / TEST_DATABASE_URL the CI lane exports. resolveDatabaseUrl
// prefers TEST_DATABASE_URL, so BOTH are pinned — otherwise the suite is steered
// to a Postgres that isn't up under the unit lane and self-skips to a vacuous
// green (a money-path proof shipping unproven).
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

// Stub the non-billing fire-and-forget side-effects the successful-debit path
// kicks off (low-credit email / webhook / auto-top-up). These are downstream
// notifications, NOT the code under test — the hold/refund/earnings SQL below
// runs entirely real against PGlite. Mirrors credits-deduct-guard.test.ts.
mock.module("../email", () => ({
  emailService: {
    sendLowCreditsEmail: mock(async () => false),
  },
}));
mock.module("../waifu-webhook", () => ({
  resolveWaifuWebhookTarget: mock(() => null),
  classifyCreditBalance: mock(() => null),
  emitWaifuCreditWebhook: mock(async () => undefined),
}));
mock.module("../auto-top-up", () => ({
  autoTopUpService: {
    executeAutoTopUp: mock(async () => undefined),
  },
}));

import { pushSchema } from "drizzle-kit/api";
import { and, eq } from "drizzle-orm";
import type { App } from "../../../db/repositories/apps";
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

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let appCreditsService: typeof import("../app-credits").appCreditsService;
let InsufficientCreditsError: typeof import("../credits").InsufficientCreditsError;
let MIN_RESERVATION: typeof import("../credits").MIN_RESERVATION;

let seq = 0;
function uniq(p: string): string {
  seq += 1;
  return `${p}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedOrg(balance: string): Promise<string> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: uniq("org"), credit_balance: balance })
    .returning();
  return org.id;
}

async function seedUser(organizationId: string): Promise<string> {
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: organizationId })
    .returning();
  return user.id;
}

async function seedApp(args: {
  organizationId: string;
  createdByUserId: string;
  inferenceMarkupPercentage: number;
}): Promise<App> {
  const [app] = await dbWrite
    .insert(apps)
    .values({
      name: uniq("app"),
      slug: uniq("app"),
      organization_id: args.organizationId,
      created_by_user_id: args.createdByUserId,
      app_url: "https://app.example.test",
      monetization_enabled: true,
      inference_markup_percentage: args.inferenceMarkupPercentage,
      purchase_share_percentage: 0,
      platform_offset_amount: 0,
    })
    .returning();
  return app as App;
}

async function orgBalance(organizationId: string): Promise<number> {
  const row = await dbWrite.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  return Number(row?.credit_balance ?? Number.NaN);
}

async function orgTransactions(
  organizationId: string,
  type: string,
): Promise<{ amount: number }[]> {
  const rows = await dbWrite.query.creditTransactions.findMany({
    where: and(
      eq(creditTransactions.organization_id, organizationId),
      eq(creditTransactions.type, type),
    ),
  });
  return rows.map((r) => ({ amount: Number(r.amount) }));
}

async function creatorRedeemableBalance(userId: string): Promise<number> {
  const row = await dbWrite.query.redeemableEarnings.findFirst({
    where: eq(redeemableEarnings.user_id, userId),
  });
  return Number(row?.available_balance ?? 0);
}

async function creatorEarningLedgerCount(userId: string): Promise<number> {
  const rows = await dbWrite.query.redeemableEarningsLedger.findMany({
    where: and(
      eq(redeemableEarningsLedger.user_id, userId),
      eq(redeemableEarningsLedger.entry_type, "earning"),
    ),
  });
  return rows.length;
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ appCreditsService } = await import("../app-credits"));
    ({ InsufficientCreditsError, MIN_RESERVATION } = await import("../credits"));

    const schema = {
      organizations,
      users,
      apps,
      appUsers,
      appEarnings,
      appEarningsTransactions,
      creditTransactions,
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
    console.error(
      "[app-credit-hold-concurrency.test] PGlite/pushSchema unavailable — skipping.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("reserveInferenceCredits — real row-locked upfront hold (#10857)", () => {
  test(
    "(ported from #10909) 8 concurrent $0.30 holds on a $1.00 balance: exactly 3 win, 5 throw InsufficientCreditsError, balance never negative",
    async () => {
      if (!pgliteReady) return;

      const payerOrgId = await seedOrg("1.000000");
      const consumerId = await seedUser(payerOrgId);
      const creatorOrgId = await seedOrg("0.000000");
      const creatorId = await seedUser(creatorOrgId);
      // 0% markup: each hold debits exactly the $0.30 estimate, so the
      // affordability arithmetic below is exact.
      const app = await seedApp({
        organizationId: creatorOrgId,
        createdByUserId: creatorId,
        inferenceMarkupPercentage: 0,
      });
      // Pre-seed the app_users activity row: first-touch row creation is a
      // separate (unique-index-guarded, compensated) seam; the property under
      // test here is the money hold, and a returning user is the steady state.
      await dbWrite.insert(appUsers).values({ app_id: app.id, user_id: consumerId });

      const HOLD = 0.3;
      const N = 8;

      const results = await Promise.allSettled(
        Array.from({ length: N }, (_, i) =>
          appCreditsService.reserveInferenceCredits({
            appId: app.id,
            userId: consumerId,
            estimatedBaseCost: HOLD,
            description: `concurrent hold ${i}`,
            idempotencyKey: `req-${i}`,
            metadata: { model: "test-model" },
            app,
          }),
        ),
      );

      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");

      // Exactly floor(1.00 / 0.30) = 3 win; the surplus fail CLOSED with the
      // typed error the routes translate to 429/402.
      expect(won).toHaveLength(3);
      expect(lost).toHaveLength(N - 3);
      for (const rejection of lost) {
        const error = (rejection as PromiseRejectedResult).reason;
        expect(error).toBeInstanceOf(InsufficientCreditsError);
        const typed = error as InstanceType<typeof InsufficientCreditsError>;
        expect(typed.required).toBeCloseTo(HOLD, 6);
        expect(typed.available).toBeLessThan(HOLD);
        expect(typed.reason).toBe("insufficient_balance");
      }

      // The load-bearing invariant: the balance NEVER went negative, and equals
      // exactly the 3 affordable holds — no overspend, no platform-absorbed loss.
      const balance = await orgBalance(payerOrgId);
      expect(balance).toBeGreaterThanOrEqual(0);
      expect(balance).toBeCloseTo(1.0 - 3 * HOLD, 6);

      // One debit row per successful hold — no phantom or duplicate debits.
      const debits = await orgTransactions(payerOrgId, "debit");
      expect(debits).toHaveLength(3);
      for (const debit of debits) {
        expect(debit.amount).toBeCloseTo(-HOLD, 6);
      }

      // Each winner carries a real reservation the routes settle through.
      for (const winner of won) {
        const reservation = (winner as PromiseFulfilledResult<{ reservedAmount: number }>).value;
        expect(reservation.reservedAmount).toBeCloseTo(HOLD, 6);
      }

      // Provider-failure path: settling one winner to zero refunds its full
      // hold back to the org balance (the routes' settle(0) on error/abort).
      const first = won[0] as PromiseFulfilledResult<
        Awaited<ReturnType<typeof appCreditsService.reserveInferenceCredits>>
      >;
      const settlement = await first.value.reconcile(0);
      expect(settlement?.adjustmentType).toBe("refund");
      expect(await orgBalance(payerOrgId)).toBeCloseTo(1.0 - 2 * HOLD, 6);
      const refunds = await orgTransactions(payerOrgId, "refund");
      expect(refunds).toHaveLength(1);
      expect(refunds[0].amount).toBeCloseTo(HOLD, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "leg-keyed creator earnings against the REAL dedupe: estimate and overage each mint once; a settlement retry does not double-credit",
    async () => {
      if (!pgliteReady) return;

      const payerOrgId = await seedOrg("10.000000");
      const consumerId = await seedUser(payerOrgId);
      const creatorOrgId = await seedOrg("0.000000");
      const creatorId = await seedUser(creatorOrgId);
      const app = await seedApp({
        organizationId: creatorOrgId,
        createdByUserId: creatorId,
        inferenceMarkupPercentage: 10,
      });

      // Upfront hold: $1 estimate + 10% markup = $1.10 debited; the creator's
      // 10¢ markup mints under the `deduct` leg of the dedupe key.
      const reservation = await appCreditsService.reserveInferenceCredits({
        appId: app.id,
        userId: consumerId,
        estimatedBaseCost: 1,
        description: "phase-key estimate",
        idempotencyKey: "req-phase-1",
        metadata: { model: "test-model" },
        app,
      });
      expect(reservation.reservedAmount).toBeCloseTo(1.1, 6);
      expect(await orgBalance(payerOrgId)).toBeCloseTo(8.9, 6);
      expect(await creatorRedeemableBalance(creatorId)).toBeCloseTo(0.1, 6);
      expect(await creatorEarningLedgerCount(creatorId)).toBe(1);

      // Actual cost $2 → $1.10 overage charge. The overage markup mints under
      // the DISTINCT `reconcile_charge` leg — if both movements shared a key,
      // the real dedupe below would swallow this legitimate 10¢.
      const overage = await reservation.reconcile(2);
      expect(overage?.adjustmentType).toBe("overage");
      expect(await orgBalance(payerOrgId)).toBeCloseTo(7.8, 6);
      expect(await creatorRedeemableBalance(creatorId)).toBeCloseTo(0.2, 6);
      expect(await creatorEarningLedgerCount(creatorId)).toBe(2);

      // A reconcile retry for the SAME request (the #10423/#10873 double-credit
      // shape) reuses the `reconcile_charge` leg key, so the REAL redeemable-
      // earnings dedupe drops the duplicate mint. (The routes' idempotent
      // settler already prevents the duplicate org charge; earnings idempotency
      // is what the leg keys must guarantee at this layer.)
      await reservation.reconcile(2);
      expect(await creatorRedeemableBalance(creatorId)).toBeCloseTo(0.2, 6);
      expect(await creatorEarningLedgerCount(creatorId)).toBe(2);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a repeated reconcile REFUND for the same reservation is idempotent — no double-refund mint (#11512)",
    async () => {
      if (!pgliteReady) return;

      const payerOrgId = await seedOrg("10.000000");
      const consumerId = await seedUser(payerOrgId);
      const creatorOrgId = await seedOrg("0.000000");
      const creatorId = await seedUser(creatorOrgId);
      const app = await seedApp({
        organizationId: creatorOrgId,
        createdByUserId: creatorId,
        inferenceMarkupPercentage: 10,
      });

      // $2 estimate + 10% markup = $2.20 debited → org 7.80.
      const reservation = await appCreditsService.reserveInferenceCredits({
        appId: app.id,
        userId: consumerId,
        estimatedBaseCost: 2,
        description: "reconcile-refund idempotency",
        idempotencyKey: "req-11512",
        metadata: { model: "test-model" },
        app,
      });
      expect(await orgBalance(payerOrgId)).toBeCloseTo(7.8, 6);

      // First settle: actual $0.5 → refund (2 − 0.5) × 1.1 = $1.65 → org 9.45.
      const first = await reservation.reconcile(0.5);
      expect(first?.adjustmentType).toBe("refund");
      expect(await orgBalance(payerOrgId)).toBeCloseTo(9.45, 6);

      // Second settle of the SAME reservation (the #11512 shape: the settler's
      // first-call-wins guard reset on a mid-settle throw, so the route's
      // fallback settleReservation(0) re-invokes reconcile). WITHOUT the
      // idempotency key this commits a SECOND, larger refund → org 11.65
      // (minted above its $10 start). WITH the key the refund dedupes on
      // stripe_payment_intent_id (ON CONFLICT DO NOTHING) → balance unchanged.
      await reservation.reconcile(0);
      expect(await orgBalance(payerOrgId)).toBeCloseTo(9.45, 6);
      // Hard invariant: never minted above the debited amount.
      expect(await orgBalance(payerOrgId)).toBeLessThan(10);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a $0 estimate opens a MIN_RESERVATION floor hold instead of throwing 'Amount must be positive' (residual of #10892)",
    async () => {
      if (!pgliteReady) return;

      const payerOrgId = await seedOrg("1.000000");
      const consumerId = await seedUser(payerOrgId);
      const creatorOrgId = await seedOrg("0.000000");
      const creatorId = await seedUser(creatorOrgId);
      // 0% markup: the hold and every reconcile adjustment move exactly the
      // base-cost figures asserted below.
      const app = await seedApp({
        organizationId: creatorOrgId,
        createdByUserId: creatorId,
        inferenceMarkupPercentage: 0,
      });
      await dbWrite.insert(appUsers).values({ app_id: app.id, user_id: consumerId });

      // calculateCost returns $0 for free/unpriced models; before the floor,
      // that reached reserveAndDeductCredits' amount<=0 guard as a PLAIN Error
      // (not InsufficientCreditsError), which /v1/chat/completions and
      // /v1/messages rethrow as a 500 on every monetized-app request.
      const reservation = await appCreditsService.reserveInferenceCredits({
        appId: app.id,
        userId: consumerId,
        estimatedBaseCost: 0,
        description: "zero-estimate hold",
        idempotencyKey: "req-zero-1",
        metadata: { model: "free-model" },
        app,
      });
      expect(reservation.reservedAmount).toBeCloseTo(MIN_RESERVATION, 9);
      expect(await orgBalance(payerOrgId)).toBeCloseTo(1 - MIN_RESERVATION, 9);

      // Actual $0 → the floor refunds in full; a free call costs nothing.
      const settlement = await reservation.reconcile(0);
      expect(settlement?.adjustmentType).toBe("refund");
      expect(await orgBalance(payerOrgId)).toBeCloseTo(1.0, 9);

      // A $0-estimate call whose ACTUAL cost is real still charges through the
      // overage leg — the floor never under-collects.
      const second = await appCreditsService.reserveInferenceCredits({
        appId: app.id,
        userId: consumerId,
        estimatedBaseCost: 0,
        description: "zero-estimate hold with real cost",
        idempotencyKey: "req-zero-2",
        metadata: { model: "free-model" },
        app,
      });
      const overage = await second.reconcile(0.05);
      expect(overage?.adjustmentType).toBe("overage");
      expect(await orgBalance(payerOrgId)).toBeCloseTo(0.95, 6);
    },
    PGLITE_TIMEOUT,
  );
});

// Loud guard: PGlite is in-process (no network), so `pgliteReady` must be true.
// If pushSchema/PGlite ever fails to init, the DB-dependent tests above
// early-return; this turns that silent no-op into a hard CI failure so a
// money-path proof can never masquerade as a vacuous green.
test("pglite schema applied — never a silent skip", () => {
  expect(pgliteReady).toBe(true);
});
