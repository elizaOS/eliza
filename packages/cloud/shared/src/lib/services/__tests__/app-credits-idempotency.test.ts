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

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;
let appCreditsService: typeof import("../app-credits").appCreditsService;

let seq = 0;
function uniq(p: string): string {
  seq += 1;
  return `${p}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seed(): Promise<{ appId: string; payerUserId: string; creatorUserId: string }> {
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
  return { appId: app.id, payerUserId: payer.id, creatorUserId: creator.id };
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

beforeAll(async () => {
  try {
    ({ appCreditsService } = await import("../app-credits"));
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

  test("two deductCredits with the SAME request idempotency key credit the creator once", async () => {
    if (!pgliteReady) return;
    const { appId, payerUserId, creatorUserId } = await seed();

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
    const second = await deduct(); // a settlement retry for the SAME request

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    // markup = baseCost * 100% = 0.01, credited exactly once (not 0.02).
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.01, 6);
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
        }),
      );

    await deduct();
    expect(await appCreatorEarningsCounter(appId)).toBeCloseTo(0.01, 6);

    await deduct(); // settlement retry: redeemable dedupes AND the counter must not move
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.01, 6);
    expect(await appCreatorEarningsCounter(appId)).toBeCloseTo(0.01, 6);
  });
});

describe("deduct + reconcile legs under ONE request key (#10847 follow-up)", () => {
  test("reconcile-overage credit is NOT deduped against the deduct-time credit", async () => {
    if (!pgliteReady) return;
    const { appId, payerUserId, creatorUserId } = await seed();

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

    // Replay the WHOLE request with the same key (a full settlement retry):
    // both legs dedupe, balance and counter stay exactly where they were.
    await runRequest();
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.03, 6);
    expect(await appCreatorEarningsCounter(appId)).toBeCloseTo(0.03, 6);
  });

  test("reconcile-refund replay reverses the creator exactly once (balance + counter)", async () => {
    if (!pgliteReady) return;
    const { appId, payerUserId, creatorUserId } = await seed();

    await runWithRequestContext({ idempotencyKey: "settle-refund" }, async () => {
      await appCreditsService.deductCredits({
        appId,
        userId: payerUserId,
        baseCost: 0.03,
        description: "inference (estimate)",
      });
      await appCreditsService.reconcileCredits({
        appId,
        userId: payerUserId,
        estimatedBaseCost: 0.03,
        actualBaseCost: 0.01,
        description: "inference (reconcile refund)",
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
      }),
    );
    expect(await creatorBalance(creatorUserId)).toBeCloseTo(0.01, 6);
    expect(await appCreatorEarningsCounter(appId)).toBeCloseTo(0.01, 6);
  });
});
