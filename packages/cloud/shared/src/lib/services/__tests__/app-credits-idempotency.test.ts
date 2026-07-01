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
import { appEarnings, appEarningsTransactions } from "../../../db/schemas/app-earnings";
import {
  appDeploymentStatusEnum,
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

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn("[app-credits-idempotency.test] non-PGlite DATABASE_URL; self-skipping.");
    return;
  }
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
});
