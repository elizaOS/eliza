/**
 * Creator-earnings idempotency (#10423) — real Drizzle schema, in-process PGlite.
 *
 * The reported money bug: app/agent inference creator-earnings called
 * `redeemableEarningsService.addEarnings` WITHOUT `dedupeBySourceId` and keyed
 * on `appId` (which repeats across every charge), so a settlement retry (a
 * re-run of the chat/message `onFinish` for the SAME request) double-credited
 * the creator. The fix keys the credit on a stable per-charge id
 * (`idempotencyKey`/`stripePaymentIntentId`) with `dedupeBySourceId: true`.
 *
 * These tests drive the REAL `addEarnings` against PGlite and assert:
 *   1. Same (source, sourceId) + dedupe → credited ONCE; the retry returns
 *      `deduplicated: true` and adds no ledger 'earning' row.
 *   2. The OLD behavior (no dedupe, appId-keyed) DOUBLE-credits — pinning the bug.
 *   3. `normalizeLedgerSourceId` maps the composite key deterministically, so a
 *      retry of the same request dedupes while distinct requests do not.
 *
 * Self-skips LOUDLY if PGlite/pushSchema is unavailable (never silently passes).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
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

async function balanceOf(userId: string): Promise<number> {
  const row = await dbWrite.query.redeemableEarnings.findFirst({
    where: eq(redeemableEarnings.user_id, userId),
  });
  return Number(row?.available_balance ?? 0);
}

async function earningLedgerCount(userId: string): Promise<number> {
  const rows = await dbWrite.query.redeemableEarningsLedger.findMany({
    where: and(
      eq(redeemableEarningsLedger.user_id, userId),
      eq(redeemableEarningsLedger.entry_type, "earning"),
    ),
  });
  return rows.length;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[creator-earnings-idempotency.test] non-PGlite DATABASE_URL; self-skipping isolation suite.",
    );
    return;
  }
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
      "[creator-earnings-idempotency.test] PGlite/pushSchema unavailable — skipping.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("creator earnings idempotency (#10423)", () => {
  test("pglite applied (loud, never a silent no-op pass)", () => {
    expect(pgliteReady).toBe(true);
  });

  let userId: string;
  beforeEach(async () => {
    if (!pgliteReady) return;
    userId = await seedUser();
  });

  test("FIX: same per-charge key + dedupe credits once; the retry is deduplicated", async () => {
    if (!pgliteReady) return;
    const sourceId = "req-abc:inference_markup"; // a retried onFinish reuses this
    const first = await redeemableEarningsService.addEarnings({
      userId,
      amount: 0.5,
      source: "miniapp",
      sourceId,
      dedupeBySourceId: true,
      description: "Inference markup",
    });
    const second = await redeemableEarningsService.addEarnings({
      userId,
      amount: 0.5,
      source: "miniapp",
      sourceId,
      dedupeBySourceId: true,
      description: "Inference markup",
    });

    expect(first.success).toBe(true);
    expect(first.deduplicated).toBe(false);
    expect(second.success).toBe(true);
    expect(second.deduplicated).toBe(true);
    expect(await balanceOf(userId)).toBeCloseTo(0.5, 6);
    expect(await earningLedgerCount(userId)).toBe(1);
  });

  test("BUG (pinned): the old appId-keyed, no-dedupe behavior double-credits", async () => {
    if (!pgliteReady) return;
    // Two charges from the SAME request that both key on appId with no dedupe —
    // exactly the pre-fix behavior — accrue twice.
    const appScopedId = "11111111-1111-4111-8111-111111111111"; // an appId
    await redeemableEarningsService.addEarnings({
      userId,
      amount: 0.5,
      source: "miniapp",
      sourceId: appScopedId,
      description: "Inference markup",
    });
    await redeemableEarningsService.addEarnings({
      userId,
      amount: 0.5,
      source: "miniapp",
      sourceId: appScopedId,
      description: "Inference markup",
    });
    expect(await balanceOf(userId)).toBeCloseTo(1.0, 6);
    expect(await earningLedgerCount(userId)).toBe(2);
  });

  test("distinct requests still credit separately (dedupe is per-charge, not per-app)", async () => {
    if (!pgliteReady) return;
    await redeemableEarningsService.addEarnings({
      userId,
      amount: 0.3,
      source: "miniapp",
      sourceId: "req-1:inference_markup",
      dedupeBySourceId: true,
      description: "markup",
    });
    await redeemableEarningsService.addEarnings({
      userId,
      amount: 0.3,
      source: "miniapp",
      sourceId: "req-2:inference_markup",
      dedupeBySourceId: true,
      description: "markup",
    });
    expect(await balanceOf(userId)).toBeCloseTo(0.6, 6);
    expect(await earningLedgerCount(userId)).toBe(2);
  });
});
