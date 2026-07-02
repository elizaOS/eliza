/**
 * Redemption refund idempotency — real Drizzle schema, in-process PGlite.
 *
 * The money bug: `refundRedemption` moved USD from `total_pending` back to
 * `available_balance` and inserted an `entry_type='refund'` ledger row keyed
 * by `redemption_id` with NO existing-refund check inside its transaction —
 * its only guard was a stale-replica read in the caller
 * (`payout-processor.ts` `refundStrandedRedemption`). Two concurrent (or
 * retried) calls both passed the replica check and each credited
 * `available_balance` — a double-refund. Its sibling `lockForRedemption`
 * already guards in-tx (findFirst on user_id + redemption_id + entry_type
 * under the row lock); the fix mirrors that pattern in `refundRedemption`.
 *
 * These tests drive the REAL `refundRedemption` against PGlite and assert:
 *   1. Single refund — balances move correctly, exactly one refund row.
 *   2. A duplicate call (same redemption_id, sequential AND concurrent)
 *      refunds ONCE: available_balance up by the amount exactly once,
 *      total_pending decremented once, ONE 'refund' ledger row.
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
import { and, eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../../db/client";
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
let redeemableEarningsService: typeof import("../redeemable-earnings").redeemableEarningsService;

let seq = 0;
function uniq(p: string): string {
  seq += 1;
  return `${p}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedUser(): Promise<string> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: uniq("org") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  return user.id;
}

async function balances(userId: string): Promise<{ available: number; pending: number }> {
  const row = await dbWrite.query.redeemableEarnings.findFirst({
    where: eq(redeemableEarnings.user_id, userId),
  });
  return {
    available: Number(row?.available_balance ?? 0),
    pending: Number(row?.total_pending ?? 0),
  };
}

async function refundLedgerCount(userId: string, redemptionId: string): Promise<number> {
  const rows = await dbWrite.query.redeemableEarningsLedger.findMany({
    where: and(
      eq(redeemableEarningsLedger.user_id, userId),
      eq(redeemableEarningsLedger.redemption_id, redemptionId),
      eq(redeemableEarningsLedger.entry_type, "refund"),
    ),
  });
  return rows.length;
}

beforeAll(async () => {
  try {
    ({ redeemableEarningsService } = await import("../redeemable-earnings"));
    const schema = {
      organizations,
      users,
      redeemableEarnings,
      redeemableEarningsLedger,
      redeemedEarningsTracking,
      earningsSourceEnum,
      ledgerEntryTypeEnum,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[redemption-refund-idempotency.test] PGlite/pushSchema unavailable — skipping.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("refundRedemption idempotency", () => {
  test("pglite applied (loud, never a silent no-op pass)", () => {
    expect(pgliteReady).toBe(true);
  });

  let userId: string;
  let redemptionId: string;
  beforeEach(async () => {
    if (!pgliteReady) return;
    userId = await seedUser();
    redemptionId = crypto.randomUUID();
    // Refundable state via the real path: earn $10, then lock $4 for redemption.
    const earned = await redeemableEarningsService.addEarnings({
      userId,
      amount: 10,
      source: "miniapp",
      sourceId: uniq("earning"),
      description: "Seed earnings",
    });
    expect(earned.success).toBe(true);
    const locked = await redeemableEarningsService.lockForRedemption({
      userId,
      amount: 4,
      redemptionId,
    });
    expect(locked.success).toBe(true);
    expect(await balances(userId)).toEqual({ available: 6, pending: 4 });
  });

  test("single refund moves pending back to available and writes one refund row", async () => {
    if (!pgliteReady) return;
    const result = await redeemableEarningsService.refundRedemption({
      userId,
      redemptionId,
      amount: 4,
      reason: "Redemption failed",
    });
    expect(result.success).toBe(true);
    expect(await balances(userId)).toEqual({ available: 10, pending: 0 });
    expect(await refundLedgerCount(userId, redemptionId)).toBe(1);
  });

  test("REGRESSION: a duplicate refundRedemption for the same redemption_id refunds ONCE", async () => {
    if (!pgliteReady) return;
    const first = await redeemableEarningsService.refundRedemption({
      userId,
      redemptionId,
      amount: 4,
      reason: "Redemption failed",
    });
    // The retry that used to double-credit: same redemption_id, stale caller guard.
    const second = await redeemableEarningsService.refundRedemption({
      userId,
      redemptionId,
      amount: 4,
      reason: "Redemption failed",
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    // Credited exactly once: available 6 → 10 (NOT 14), pending 4 → 0.
    expect(await balances(userId)).toEqual({ available: 10, pending: 0 });
    expect(await refundLedgerCount(userId, redemptionId)).toBe(1);
  });

  test("REGRESSION: a concurrent refund pair for the same redemption_id refunds ONCE", async () => {
    if (!pgliteReady) return;
    const [first, second] = await Promise.all([
      redeemableEarningsService.refundRedemption({
        userId,
        redemptionId,
        amount: 4,
        reason: "Redemption failed",
      }),
      redeemableEarningsService.refundRedemption({
        userId,
        redemptionId,
        amount: 4,
        reason: "Redemption failed",
      }),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(await balances(userId)).toEqual({ available: 10, pending: 0 });
    expect(await refundLedgerCount(userId, redemptionId)).toBe(1);
  });
});
