/**
 * App-credits creator-earnings idempotency — REAL path (#10423).
 *
 * Drives the CHANGED code end-to-end: `AppCreditsService.deductCredits` →
 * `recordCreatorEarnings` → `redeemableEarningsService.addEarnings`, twice with
 * the SAME request idempotency key (via the `runWithRequestContext` ALS the
 * Cloud API sets per request), against in-process PGlite. Asserts the app
 * creator's redeemable balance is credited exactly ONCE — i.e. a settlement
 * retry no longer double-credits.
 *
 * Fails loudly (via the `pgliteReady` guard) if PGlite/pushSchema ever fails to initialize — never a silent skip.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
import { and, eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../../db/client";
import { appEarningsRepository } from "../../../db/repositories/app-earnings";
import { appEarnings, appEarningsTransactions } from "../../../db/schemas/app-earnings";
import {
  appReservationSettlementQuarantines,
  appReservationSettlements,
} from "../../../db/schemas/app-reservation-settlements";
import { appUsageProjections } from "../../../db/schemas/app-usage-projections";
import {
  appDeploymentStatusEnum,
  appReviewStatusEnum,
  apps,
  appUsers,
  userDatabaseStatusEnum,
} from "../../../db/schemas/apps";
import { creditTransactions } from "../../../db/schemas/credit-transactions";
import {
  organizationBalanceRevisionSequence,
  organizations,
} from "../../../db/schemas/organizations";
import {
  earningsSourceEnum,
  ledgerEntryTypeEnum,
  redeemableEarnings,
  redeemableEarningsLedger,
  redeemedEarningsTracking,
} from "../../../db/schemas/redeemable-earnings";
import { users } from "../../../db/schemas/users";
import { runWithRequestContext } from "../../runtime/request-context";
import { redeemableEarningsService } from "../redeemable-earnings";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;
let appCreditsService: typeof import("../app-credits").appCreditsService;
let projectAppUsageForDebit: typeof import("../app-usage-projections").projectAppUsageForDebit;
let sweepPendingAppUsageProjections: typeof import("../app-usage-projections").sweepPendingAppUsageProjections;
let recoverExpiredInferenceAdmissionLease: typeof import("../inference-admission-recovery").recoverExpiredInferenceAdmissionLease;

let seq = 0;
function uniq(p: string): string {
  seq += 1;
  return `${p}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seed(): Promise<{
  appId: string;
  payerOrganizationId: string;
  payerUserId: string;
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
    payerOrganizationId: payerOrg.id,
    payerUserId: payer.id,
    creatorUserId: creator.id,
  };
}

async function creatorBalance(userId: string): Promise<number> {
  const row = await dbWrite.query.redeemableEarnings.findFirst({
    where: eq(redeemableEarnings.user_id, userId),
  });
  return Number(row?.available_balance ?? 0);
}

async function appCreatorEarningsCounter(appId: string): Promise<number> {
  const [row] = await dbWrite.select().from(apps).where(eq(apps.id, appId));
  return Number(row?.total_creator_earnings ?? 0);
}

async function payerBalance(organizationId: string): Promise<number> {
  const [row] = await dbWrite
    .select({ balance: organizations.credit_balance })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return Number(row.balance);
}

async function payerBalanceRevision(organizationId: string): Promise<number> {
  const [row] = await dbWrite
    .select({ revision: organizations.balance_revision })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return Number(row.revision);
}

async function creatorProjection(appId: string): Promise<{
  lifetime: number;
  inference: number;
  withdrawable: number;
  creatorTotal: number;
  platformTotal: number;
  transactionCount: number;
}> {
  const [earnings] = await dbWrite.select().from(appEarnings).where(eq(appEarnings.app_id, appId));
  const [app] = await dbWrite.select().from(apps).where(eq(apps.id, appId));
  const transactions = await dbWrite
    .select()
    .from(appEarningsTransactions)
    .where(eq(appEarningsTransactions.app_id, appId));
  return {
    lifetime: Number(earnings?.total_lifetime_earnings ?? Number.NaN),
    inference: Number(earnings?.total_inference_earnings ?? Number.NaN),
    withdrawable: Number(earnings?.withdrawable_balance ?? Number.NaN),
    creatorTotal: Number(app.total_creator_earnings),
    platformTotal: Number(app.total_platform_revenue),
    transactionCount: transactions.length,
  };
}

async function creatorLedgerMovementCount(userId: string): Promise<number> {
  const rows = await dbWrite
    .select({ id: redeemableEarningsLedger.id })
    .from(redeemableEarningsLedger)
    .where(
      and(
        eq(redeemableEarningsLedger.user_id, userId),
        eq(redeemableEarningsLedger.earnings_source, "miniapp"),
      ),
    );
  return rows.length;
}

async function usageProjection(
  appId: string,
  userId: string,
): Promise<{
  appRequests: number;
  appCredits: number;
  userRequests: number;
  userCredits: number;
  projectionCount: number;
  status: string | undefined;
}> {
  const [app] = await dbWrite.select().from(apps).where(eq(apps.id, appId));
  const [appUser] = await dbWrite
    .select()
    .from(appUsers)
    .where(and(eq(appUsers.app_id, appId), eq(appUsers.user_id, userId)));
  const projections = await dbWrite
    .select()
    .from(appUsageProjections)
    .where(eq(appUsageProjections.app_id, appId));
  return {
    appRequests: app?.total_requests ?? 0,
    appCredits: Number(app?.total_credits_used ?? 0),
    userRequests: appUser?.total_requests ?? 0,
    userCredits: Number(appUser?.total_credits_used ?? 0),
    projectionCount: projections.length,
    status: projections[0]?.status,
  };
}

async function insertUsageSource(params: {
  appId: string;
  userId: string;
  organizationId: string;
  amount: number;
}): Promise<string> {
  const [source] = await dbWrite
    .insert(creditTransactions)
    .values({
      organization_id: params.organizationId,
      amount: String(-params.amount),
      type: "debit",
      description: "durable app usage source",
      metadata: {
        appUsageProjectionVersion: 1,
        appId: params.appId,
        userId: params.userId,
        totalCost: params.amount,
      },
    })
    .returning({ id: creditTransactions.id });
  return source.id;
}

function appRecoveryContext(params: {
  appId: string;
  userId: string;
  organizationId: string;
  creatorUserId: string;
  requestId: string;
}) {
  return {
    version: 1 as const,
    kind: "app" as const,
    organizationId: params.organizationId,
    requestId: params.requestId,
    userId: params.userId,
    model: "test/model",
    provider: "test",
    billingSource: "gateway",
    description: "Recovered deleted-app inference",
    appId: params.appId,
    estimatedBaseCostUsd: 0.01,
    appPolicy: {
      name: "Monetized App",
      creatorUserId: params.creatorUserId,
      monetizationEnabled: true,
      reviewStatus: "approved" as const,
      platformOffsetAmount: 0,
      purchaseSharePercentage: 0,
      inferenceMarkupPercentage: 100,
    },
  };
}

beforeAll(async () => {
  try {
    ({ appCreditsService } = await import("../app-credits"));
    ({ projectAppUsageForDebit, sweepPendingAppUsageProjections } = await import(
      "../app-usage-projections"
    ));
    ({ recoverExpiredInferenceAdmissionLease } = await import("../inference-admission-recovery"));
    const schema = {
      organizations,
      organizationBalanceRevisionSequence,
      users,
      apps,
      appUsers,
      appEarnings,
      appEarningsTransactions,
      redeemableEarnings,
      redeemableEarningsLedger,
      redeemedEarningsTracking,
      creditTransactions,
      appReservationSettlements,
      appReservationSettlementQuarantines,
      appUsageProjections,
      appDeploymentStatusEnum,
      appReviewStatusEnum,
      userDatabaseStatusEnum,
      earningsSourceEnum,
      ledgerEntryTypeEnum,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
    // pushSchema derives DDL from the drizzle schema, which cannot express the
    // 0177 balance-revision trigger. Apply the real migration file (its
    // statements are IF NOT EXISTS / OR REPLACE safe on top of pushSchema) so
    // these money tests run the same trigger production deploys, and a real
    // debit is proven to advance the service-visible balance revision.
    const migration0177 = readFileSync(
      join(import.meta.dir, "../../../db/migrations/0177_organization_balance_revision.sql"),
      "utf8",
    );
    for (const statement of migration0177.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await dbWrite.execute(trimmed);
    }
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[app-credits-idempotency.test] PGlite/pushSchema unavailable — skipping.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("deductCredits creator-earnings idempotency (#10423)", () => {
  test("pglite applied (loud, never silent no-op)", () => {
    expect(pgliteReady).toBe(true);
  });

  test("a real debit advances organizations.balance_revision through the 0177 trigger", async () => {
    if (!pgliteReady) return;
    const { appId, payerOrganizationId, payerUserId } = await seed();
    const before = await payerBalanceRevision(payerOrganizationId);

    const result = await runWithRequestContext({ idempotencyKey: uniq("revision") }, async () =>
      appCreditsService.deductCredits({
        appId,
        userId: payerUserId,
        baseCost: 0.01,
        description: "revision proof",
      }),
    );

    expect(result.success).toBe(true);
    // The trigger (migration 0177) must fire on the credit_balance UPDATE the
    // real deduct SQL performs — this is the revision the admission gate's
    // stale-hint protection consumes, so a frozen revision here would mean
    // spent balance could be resurrected from a stale cache snapshot.
    const after = await payerBalanceRevision(payerOrganizationId);
    expect(after).toBeGreaterThan(before);
  });

  test("two distinct debit rows under one ALS key each pay their backed creator movement", async () => {
    if (!pgliteReady) return;
    const { appId, payerOrganizationId, payerUserId, creatorUserId } = await seed();

    const deduct = () =>
      runWithRequestContext({ idempotencyKey: "settle-key-1" }, async () =>
        appCreditsService.deductCredits({
          appId,
          userId: payerUserId,
          baseCost: 0.01,
          description: "inference",
        }),
      );

    const first = await deduct();
    const second = await deduct();

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    // ALS context is not a money idempotency key. Two actual debit rows each
    // back one creator movement and one platform-revenue movement.
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.02, 6);
    expect(await payerBalance(payerOrganizationId)).toBeCloseTo(99.96, 6);
    const projection = await creatorProjection(appId);
    expect(projection.creatorTotal).toBeCloseTo(0.02, 6);
    expect(projection.platformTotal).toBeCloseTo(0.02, 6);
    expect(projection.transactionCount).toBe(2);
  });

  test("different request keys credit the creator per charge", async () => {
    if (!pgliteReady) return;
    const { appId, payerUserId, creatorUserId } = await seed();

    await runWithRequestContext({ idempotencyKey: "req-A" }, async () =>
      appCreditsService.deductCredits({
        appId,
        userId: payerUserId,
        baseCost: 0.01,
        description: "a",
      }),
    );
    await runWithRequestContext({ idempotencyKey: "req-B" }, async () =>
      appCreditsService.deductCredits({
        appId,
        userId: payerUserId,
        baseCost: 0.01,
        description: "b",
      }),
    );
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.02, 6);
  });

  test("true retry leaves apps.total_creator_earnings unchanged (no counter drift)", async () => {
    if (!pgliteReady) return;
    const { appId, payerUserId, creatorUserId } = await seed();

    const deduct = () =>
      runWithRequestContext({ idempotencyKey: "settle-counter" }, async () =>
        appCreditsService.deductCredits({
          appId,
          userId: payerUserId,
          baseCost: 0.01,
          description: "inference",
          idempotencyKey: "server-settle-counter",
        }),
      );

    await deduct();
    expect(await appCreatorEarningsCounter(appId)).toBeCloseTo(0.01, 6);

    await deduct(); // settlement retry: redeemable dedupes AND the counter must not move
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.01, 6);
    expect(await appCreatorEarningsCounter(appId)).toBeCloseTo(0.01, 6);
  });
});

describe("app usage debit projection", () => {
  test("commit acknowledgement loss replays without incrementing counters twice", async () => {
    if (!pgliteReady) return;
    const { appId, payerOrganizationId, payerUserId } = await seed();
    const transactionId = await insertUsageSource({
      appId,
      userId: payerUserId,
      organizationId: payerOrganizationId,
      amount: 0.02,
    });

    const committed = await projectAppUsageForDebit(transactionId);
    // The caller loses this acknowledgement and repeats the durable source.
    const replay = await projectAppUsageForDebit(transactionId);

    expect(committed).toMatchObject({
      status: "applied",
      deduplicated: false,
    });
    expect(replay).toMatchObject({
      status: "applied",
      deduplicated: true,
    });
    expect(await usageProjection(appId, payerUserId)).toEqual({
      appRequests: 1,
      appCredits: 0.02,
      userRequests: 1,
      userCredits: 0.02,
      projectionCount: 1,
      status: "applied",
    });
  });

  test("concurrent projection claims increment app and app-user counters once", async () => {
    if (!pgliteReady) return;
    const { appId, payerOrganizationId, payerUserId } = await seed();
    const transactionId = await insertUsageSource({
      appId,
      userId: payerUserId,
      organizationId: payerOrganizationId,
      amount: 0.03,
    });

    const results = await Promise.all(
      Array.from({ length: 16 }, () => projectAppUsageForDebit(transactionId)),
    );

    expect(results.filter((result) => !result.deduplicated)).toHaveLength(1);
    expect(results.filter((result) => result.deduplicated)).toHaveLength(15);
    expect(await usageProjection(appId, payerUserId)).toEqual({
      appRequests: 1,
      appCredits: 0.03,
      userRequests: 1,
      userCredits: 0.03,
      projectionCount: 1,
      status: "applied",
    });
  });

  test("the durable sweep projects a debit without inline analytics work", async () => {
    if (!pgliteReady) return;
    const { appId, payerOrganizationId, payerUserId } = await seed();
    await insertUsageSource({
      appId,
      userId: payerUserId,
      organizationId: payerOrganizationId,
      amount: 0.04,
    });

    const stats = await sweepPendingAppUsageProjections({
      limit: 100,
      concurrency: 4,
    });

    expect(stats.applied).toBeGreaterThanOrEqual(1);
    expect(stats.failed).toBe(0);
    expect(await usageProjection(appId, payerUserId)).toEqual({
      appRequests: 1,
      appCredits: 0.04,
      userRequests: 1,
      userCredits: 0.04,
      projectionCount: 1,
      status: "applied",
    });
  });
});

describe("deleted app inference recovery", () => {
  test("delete before the debit still collects and pays from pinned policy", async () => {
    if (!pgliteReady) return;
    const { appId, payerOrganizationId, payerUserId, creatorUserId } = await seed();
    const requestId = uniq("deleted-before-debit");
    const context = appRecoveryContext({
      appId,
      userId: payerUserId,
      organizationId: payerOrganizationId,
      creatorUserId,
      requestId,
    });
    await dbWrite.delete(apps).where(eq(apps.id, appId));

    const first = await recoverExpiredInferenceAdmissionLease(context, 0.02);
    const replay = await recoverExpiredInferenceAdmissionLease(context, 0.02);

    expect(first.collectedUsd).toBeCloseTo(0.02, 6);
    expect(first.gateConsumedUsd).toBeCloseTo(0.02, 6);
    expect(replay).toEqual(first);
    expect(await payerBalance(payerOrganizationId)).toBeCloseTo(99.98, 6);
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.01, 6);
    expect(await creatorLedgerMovementCount(creatorUserId)).toBe(1);
    await sweepPendingAppUsageProjections({
      limit: 2_000,
      concurrency: 16,
    });
    const debitRows = await dbWrite
      .select()
      .from(creditTransactions)
      .where(
        eq(
          creditTransactions.stripe_payment_intent_id,
          `app-inference:${payerOrganizationId}:${appId}:${requestId}`,
        ),
      );
    expect(debitRows).toHaveLength(1);
    expect(debitRows[0]?.settled_at).toBeTruthy();
    const projections = await dbWrite
      .select()
      .from(appUsageProjections)
      .where(eq(appUsageProjections.charge_transaction_id, debitRows[0]!.id));
    expect(projections).toHaveLength(1);
    expect(projections[0]?.status).toBe("skipped_missing_app");
    expect(await dbWrite.select().from(appUsers).where(eq(appUsers.app_id, appId))).toHaveLength(0);
  });

  test("delete after the debit lets alarm recovery finish the same reservation", async () => {
    if (!pgliteReady) return;
    const { appId, payerOrganizationId, payerUserId, creatorUserId } = await seed();
    const requestId = uniq("deleted-after-debit");
    await appCreditsService.reserveInferenceCredits({
      appId,
      userId: payerUserId,
      organizationId: payerOrganizationId,
      estimatedBaseCost: 0.01,
      description: "Debit before app deletion",
      idempotencyKey: requestId,
      retainChargeOnPostDebitFailure: true,
    });
    await dbWrite.delete(apps).where(eq(apps.id, appId));

    const recovered = await recoverExpiredInferenceAdmissionLease(
      appRecoveryContext({
        appId,
        userId: payerUserId,
        organizationId: payerOrganizationId,
        creatorUserId,
        requestId,
      }),
      0.02,
    );

    expect(recovered.collectedUsd).toBeCloseTo(0.02, 6);
    expect(recovered.gateConsumedUsd).toBeCloseTo(0.02, 6);
    expect(await payerBalance(payerOrganizationId)).toBeCloseTo(99.98, 6);
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.01, 6);
    expect(await creatorLedgerMovementCount(creatorUserId)).toBe(1);
    const debitRows = await dbWrite
      .select()
      .from(creditTransactions)
      .where(
        eq(
          creditTransactions.stripe_payment_intent_id,
          `app-inference:${payerOrganizationId}:${appId}:${requestId}`,
        ),
      );
    expect(debitRows).toHaveLength(1);
    expect(debitRows[0]?.settled_at).toBeTruthy();
  });
});

describe("creator movement retry healing", () => {
  test("redeemable commit acknowledgement loss heals the full projection once", async () => {
    if (!pgliteReady) return;
    const { appId, payerOrganizationId, payerUserId, creatorUserId } = await seed();
    const originalAdd = redeemableEarningsService.addEarnings.bind(redeemableEarningsService);
    let loseAcknowledgement = true;
    const addSpy = spyOn(redeemableEarningsService, "addEarnings").mockImplementation(
      async (params) => {
        const result = await originalAdd(params);
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error("simulated redeemable commit acknowledgement loss");
        }
        return result;
      },
    );
    const stableKey = uniq("redeemable-ack-stable");
    const stableDeduction = () =>
      appCreditsService.deductCredits({
        appId,
        userId: payerUserId,
        baseCost: 0.01,
        description: "ack-loss",
        idempotencyKey: stableKey,
      });

    try {
      await expect(stableDeduction()).rejects.toThrow(
        "simulated redeemable commit acknowledgement loss",
      );
      const [successorOrg] = await dbWrite
        .insert(organizations)
        .values({ name: "Successor", slug: uniq("successor") })
        .returning();
      const [successor] = await dbWrite
        .insert(users)
        .values({
          steward_user_id: uniq("successor-u"),
          organization_id: successorOrg.id,
        })
        .returning();
      await dbWrite
        .update(apps)
        .set({
          created_by_user_id: successor.id,
          monetization_enabled: false,
          review_status: "rejected",
          inference_markup_percentage: 0,
        })
        .where(eq(apps.id, appId));
      const retry = await stableDeduction();
      expect(retry.success).toBe(true);
      expect(await creatorBalance(successor.id)).toBe(0);
      expect(await creatorLedgerMovementCount(successor.id)).toBe(0);
    } finally {
      addSpy.mockRestore();
    }

    expect(await payerBalance(payerOrganizationId)).toBeCloseTo(99.98, 6);
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.01, 6);
    expect(await creatorLedgerMovementCount(creatorUserId)).toBe(1);
    expect(await creatorProjection(appId)).toEqual({
      lifetime: 0.01,
      inference: 0.01,
      withdrawable: 0.01,
      creatorTotal: 0.01,
      platformTotal: 0.01,
      transactionCount: 1,
    });
  });

  test("reservation retry and reconcile retain charge-time owner and markup", async () => {
    if (!pgliteReady) return;
    const { appId, payerOrganizationId, payerUserId, creatorUserId } = await seed();
    const originalProjection =
      appEarningsRepository.applyCreatorMovement.bind(appEarningsRepository);
    let loseAcknowledgement = true;
    const projectionSpy = spyOn(appEarningsRepository, "applyCreatorMovement").mockImplementation(
      async (params, transaction) => {
        const result = await originalProjection(params, transaction);
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error("simulated reservation projection acknowledgement loss");
        }
        return result;
      },
    );
    const stableKey = uniq("reservation-contract");
    const reserve = () =>
      appCreditsService.reserveInferenceCredits({
        appId,
        userId: payerUserId,
        organizationId: payerOrganizationId,
        estimatedBaseCost: 0.01,
        description: "immutable reservation contract",
        idempotencyKey: stableKey,
      });

    let successorUserId: string;
    try {
      await expect(reserve()).rejects.toThrow(
        "simulated reservation projection acknowledgement loss",
      );
      const [successorOrg] = await dbWrite
        .insert(organizations)
        .values({ name: "Successor", slug: uniq("successor") })
        .returning();
      const [successor] = await dbWrite
        .insert(users)
        .values({
          steward_user_id: uniq("successor-u"),
          organization_id: successorOrg.id,
        })
        .returning();
      successorUserId = successor.id;
      await dbWrite
        .update(apps)
        .set({
          created_by_user_id: successor.id,
          monetization_enabled: false,
          review_status: "rejected",
          inference_markup_percentage: 0,
        })
        .where(eq(apps.id, appId));

      const reservation = await reserve();
      const settlement = await reservation.reconcile(0.02);
      expect(settlement?.actualCost).toBeCloseTo(0.04, 6);
      expect(settlement?.adjustmentType).toBe("overage");
    } finally {
      projectionSpy.mockRestore();
    }

    expect(await payerBalance(payerOrganizationId)).toBeCloseTo(99.96, 6);
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.02, 6);
    expect(await creatorBalance(successorUserId!)).toBe(0);
    expect(await creatorLedgerMovementCount(creatorUserId)).toBe(2);
    expect(await creatorProjection(appId)).toEqual({
      lifetime: 0.02,
      inference: 0.02,
      withdrawable: 0.02,
      creatorTotal: 0.02,
      platformTotal: 0.02,
      transactionCount: 2,
    });
    await sweepPendingAppUsageProjections({
      limit: 2_000,
      concurrency: 16,
    });
    expect(await usageProjection(appId, payerUserId)).toEqual({
      appRequests: 1,
      appCredits: 0.02,
      userRequests: 1,
      userCredits: 0.02,
      projectionCount: 1,
      status: "applied",
    });
  });

  test("purchase retry pays the charge-time owner after ownership changes", async () => {
    if (!pgliteReady) return;
    const { appId, payerOrganizationId, payerUserId, creatorUserId } = await seed();
    await dbWrite
      .update(apps)
      .set({
        platform_offset_amount: 1,
        purchase_share_percentage: 20,
      })
      .where(eq(apps.id, appId));

    const originalAdd = redeemableEarningsService.addEarnings.bind(redeemableEarningsService);
    let loseAcknowledgement = true;
    const addSpy = spyOn(redeemableEarningsService, "addEarnings").mockImplementation(
      async (params) => {
        const result = await originalAdd(params);
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error("simulated purchase payout acknowledgement loss");
        }
        return result;
      },
    );
    const paymentIntentId = uniq("pi_purchase_owner");
    const purchase = () =>
      appCreditsService.processPurchase({
        appId,
        userId: payerUserId,
        organizationId: payerOrganizationId,
        purchaseAmount: 10,
        stripePaymentIntentId: paymentIntentId,
      });

    let successorUserId: string;
    try {
      await expect(purchase()).rejects.toThrow("simulated purchase payout acknowledgement loss");
      const [successorOrg] = await dbWrite
        .insert(organizations)
        .values({ name: "Purchase Successor", slug: uniq("purchase-successor") })
        .returning();
      const [successor] = await dbWrite
        .insert(users)
        .values({
          steward_user_id: uniq("purchase-successor-u"),
          organization_id: successorOrg.id,
        })
        .returning();
      successorUserId = successor.id;
      await dbWrite
        .update(apps)
        .set({
          created_by_user_id: successor.id,
          monetization_enabled: false,
          review_status: "rejected",
          platform_offset_amount: 0,
          purchase_share_percentage: 0,
        })
        .where(eq(apps.id, appId));

      const retry = await purchase();
      expect(retry.creditsAdded).toBe(10);
      expect(retry.platformOffset).toBe(1);
      expect(retry.creatorEarnings).toBeCloseTo(1.8, 6);
    } finally {
      addSpy.mockRestore();
    }

    expect(await payerBalance(payerOrganizationId)).toBeCloseTo(110, 6);
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(1.8, 6);
    expect(await creatorBalance(successorUserId!)).toBe(0);
    expect(await creatorLedgerMovementCount(creatorUserId)).toBe(1);
    expect(await creatorProjection(appId)).toEqual({
      lifetime: 1.8,
      inference: 0,
      withdrawable: 1.8,
      creatorTotal: 1.8,
      platformTotal: 1,
      transactionCount: 1,
    });
  });

  test("atomic projection acknowledgement loss replays without moving any total twice", async () => {
    if (!pgliteReady) return;
    const { appId, payerOrganizationId, payerUserId, creatorUserId } = await seed();
    const originalProjection =
      appEarningsRepository.applyCreatorMovement.bind(appEarningsRepository);
    let loseAcknowledgement = true;
    const projectionSpy = spyOn(appEarningsRepository, "applyCreatorMovement").mockImplementation(
      async (params, transaction) => {
        const result = await originalProjection(params, transaction);
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error("simulated projection commit acknowledgement loss");
        }
        return result;
      },
    );
    const stableKey = uniq("projection-ack");
    const deduct = () =>
      appCreditsService.deductCredits({
        appId,
        userId: payerUserId,
        baseCost: 0.01,
        description: "projection-ack-loss",
        idempotencyKey: stableKey,
      });

    try {
      await expect(deduct()).rejects.toThrow("simulated projection commit acknowledgement loss");
      const retry = await deduct();
      expect(retry.success).toBe(true);
    } finally {
      projectionSpy.mockRestore();
    }

    expect(await payerBalance(payerOrganizationId)).toBeCloseTo(99.98, 6);
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.01, 6);
    expect(await creatorLedgerMovementCount(creatorUserId)).toBe(1);
    expect(await creatorProjection(appId)).toEqual({
      lifetime: 0.01,
      inference: 0.01,
      withdrawable: 0.01,
      creatorTotal: 0.01,
      platformTotal: 0.01,
      transactionCount: 1,
    });
  });

  test("concurrent projection replays claim once and reject a changed platform delta", async () => {
    if (!pgliteReady) return;
    const { appId, payerUserId, creatorUserId } = await seed();
    const sourceId = crypto.randomUUID();
    const earning = await redeemableEarningsService.addEarnings({
      userId: creatorUserId,
      amount: 0.01,
      source: "miniapp",
      sourceId,
      dedupeBySourceId: true,
      description: "projection concurrency",
      metadata: {
        appId,
        earningsType: "inference_markup",
        transactionUserId: payerUserId,
        appCreatorShadowVersion: 1,
        appPlatformRevenueDelta: "0.010000",
      },
    });
    const movement = {
      appId,
      userId: payerUserId,
      type: "inference_markup" as const,
      creatorAmount: 0.01,
      platformRevenueAmount: 0.01,
      description: "projection concurrency",
      metadata: { sourceId },
      redeemableLedgerEntryId: earning.ledgerEntryId,
      redeemableDeduplicated: false,
    };

    const results = await Promise.all([
      appEarningsRepository.applyCreatorMovement(movement),
      appEarningsRepository.applyCreatorMovement(movement),
    ]);
    expect(results.filter((result) => !result.deduplicated)).toHaveLength(1);
    expect(results.filter((result) => result.deduplicated)).toHaveLength(1);
    await expect(
      appEarningsRepository.applyCreatorMovement({
        ...movement,
        platformRevenueAmount: 0.02,
      }),
    ).rejects.toThrow("redeemable platform revenue differs");
    expect((await creatorProjection(appId)).transactionCount).toBe(1);
  });

  test("creator projection uses the same round-down boundary as the redeemable ledger", async () => {
    if (!pgliteReady) return;
    const { appId, payerUserId, creatorUserId } = await seed();
    const sourceId = crypto.randomUUID();
    const earning = await redeemableEarningsService.addEarnings({
      userId: creatorUserId,
      amount: 0.00019,
      source: "miniapp",
      sourceId,
      dedupeBySourceId: true,
      description: "round-down projection",
      metadata: {
        appId,
        earningsType: "inference_markup",
        transactionUserId: payerUserId,
        appCreatorShadowVersion: 1,
        appPlatformRevenueDelta: "0.000010",
      },
    });

    await expect(
      appEarningsRepository.applyCreatorMovement({
        appId,
        userId: payerUserId,
        type: "inference_markup",
        creatorAmount: 0.00019,
        platformRevenueAmount: 0.00001,
        description: "round-down projection",
        metadata: { sourceId },
        redeemableLedgerEntryId: earning.ledgerEntryId,
        redeemableDeduplicated: false,
      }),
    ).resolves.toMatchObject({ deduplicated: false });
    expect(await creatorProjection(appId)).toEqual({
      lifetime: 0.0001,
      inference: 0.0001,
      withdrawable: 0.0001,
      creatorTotal: 0.0001,
      platformTotal: 0.00001,
      transactionCount: 1,
    });
  });

  test("sub-ledger-unit creator markup is explicitly not recorded and never fails the consumer charge", async () => {
    if (!pgliteReady) return;
    const { appId, payerOrganizationId, payerUserId, creatorUserId } = await seed();
    // 100% markup on the MIN_RESERVATION floor: the creator's 0.000001 markup
    // floors below the 0.0001 redeemable ledger unit. The designed outcome
    // (mirroring the affiliate outbox's below-unit rule) is that the consumer
    // hold COMMITS while the sub-unit markup is explicitly not recorded — no
    // fabricated $0.0000 ledger row and no shadow projection.
    const reservation = await appCreditsService.reserveInferenceCredits({
      appId,
      userId: payerUserId,
      organizationId: payerOrganizationId,
      estimatedBaseCost: 0.000001,
      description: "tiny movement",
      idempotencyKey: uniq("tiny-movement"),
    });
    expect(reservation.reservationTransactionId).toBeTruthy();

    // Base 0.000001 + 100% markup = 0.000002 debited from the consumer.
    expect(await payerBalance(payerOrganizationId)).toBeCloseTo(100 - 0.000002, 9);
    expect(await creatorBalance(creatorUserId)).toBe(0);
    expect(await creatorLedgerMovementCount(creatorUserId)).toBe(0);
    expect(
      await dbWrite.query.appEarnings.findFirst({
        where: eq(appEarnings.app_id, appId),
      }),
    ).toBeUndefined();
    expect(
      await dbWrite.query.appEarningsTransactions.findMany({
        where: eq(appEarningsTransactions.app_id, appId),
      }),
    ).toHaveLength(0);
  });
});

describe("deduct + reconcile legs under ONE request key (#10847 follow-up)", () => {
  test("reconcile-overage credit is NOT deduped against the deduct-time credit", async () => {
    if (!pgliteReady) return;
    const { appId, payerOrganizationId, payerUserId, creatorUserId } = await seed();

    // The apps/[id]/chat shape: deduct the (1.5x-buffered) estimate, then
    // reconcile to the higher actual — both inside the SAME request context.
    const runRequest = () =>
      runWithRequestContext({ idempotencyKey: "settle-two-legs" }, async () => {
        const deduction = await appCreditsService.deductCredits({
          appId,
          userId: payerUserId,
          baseCost: 0.01,
          description: "inference (estimate)",
        });
        expect(deduction.success).toBe(true);
        await appCreditsService.reconcileCredits({
          appId,
          userId: payerUserId,
          estimatedBaseCost: 0.01,
          actualBaseCost: 0.03,
          description: "inference (reconcile)",
        });
      });

    await runRequest();
    // markup = 100%: deduct leg credits 0.01, reconcile-charge leg credits the
    // 0.02 overage. Before the leg-keyed sourceId the second credit collided
    // with the first and was silently dropped (creator got 0.01, not 0.03).
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.03, 6);
    expect(await appCreatorEarningsCounter(appId)).toBeCloseTo(0.03, 6);

    // ALS request context is observability context, not a money idempotency
    // contract. A second invocation creates two new backing debits, so both
    // creator movements must be paid again.
    await runRequest();
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.06, 6);
    expect(await appCreatorEarningsCounter(appId)).toBeCloseTo(0.06, 6);
    expect(await payerBalance(payerOrganizationId)).toBeCloseTo(99.88, 6);
  });

  test("reconcile-refund replay reverses the creator exactly once (balance + counter)", async () => {
    if (!pgliteReady) return;
    const { appId, payerUserId, creatorUserId } = await seed();
    let reservationTransactionId: string | undefined;

    await runWithRequestContext({ idempotencyKey: "settle-refund" }, async () => {
      const deduction = await appCreditsService.deductCredits({
        appId,
        userId: payerUserId,
        baseCost: 0.03,
        description: "inference (estimate)",
      });
      reservationTransactionId = deduction.transactionId;
      expect(reservationTransactionId).toBeTruthy();
      await appCreditsService.reconcileCredits({
        appId,
        userId: payerUserId,
        estimatedBaseCost: 0.03,
        actualBaseCost: 0.01,
        description: "inference (reconcile refund)",
        reservationTransactionId,
      });
    });
    // +0.03 (deduct leg) − 0.02 (refund leg) at 100% markup.
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.01, 6);
    expect(await appCreatorEarningsCounter(appId)).toBeCloseTo(0.01, 6);

    // Retry ONLY the refund settlement with the same key: the reduce dedupes
    // and the GREATEST(0, …) counter decrement must be skipped with it —
    // before the fix the counter drifted 0.01 → 0 while the balance held.
    await runWithRequestContext({ idempotencyKey: "settle-refund" }, async () =>
      appCreditsService.reconcileCredits({
        appId,
        userId: payerUserId,
        estimatedBaseCost: 0.03,
        actualBaseCost: 0.01,
        description: "inference (reconcile refund retry)",
        reservationTransactionId,
      }),
    );
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.01, 6);
    expect(await appCreatorEarningsCounter(appId)).toBeCloseTo(0.01, 6);
  });
});
