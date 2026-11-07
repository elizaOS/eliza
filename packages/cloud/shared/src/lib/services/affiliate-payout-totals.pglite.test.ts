/**
 * Paying out affiliate earnings through Stripe Connect is a redemption: it
 * must raise total_redeemed and leave lifetime earnings unchanged, and a
 * rejected transfer must restore the redemption rather than book new income.
 * Runs the real ledger service on PGlite.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

const { pushSchema } = await import("drizzle-kit/api");
const { eq, sql } = await import("drizzle-orm");
const { organizations } = await import("../../db/schemas/organizations");
const { users } = await import("../../db/schemas/users");
const redeemableEarningsSchema = await import("../../db/schemas/redeemable-earnings");
const { redeemableEarnings } = redeemableEarningsSchema;

let dbWrite: typeof import("../../db/client").dbWrite;
let closeDb: (() => Promise<void>) | undefined;
let userId: string;

beforeAll(async () => {
  ({ dbWrite, closeDatabaseConnectionsForTests: closeDb } = await import("../../db/client"));
  const { apply } = await pushSchema(
    { organizations, users, ...redeemableEarningsSchema } as never,
    dbWrite as never,
  );
  await apply();
  const migration = await readFile(
    new URL("../../db/migrations/0500_retire_creator_monetization.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (!trimmed) continue;
    if (/UPDATE "(user_characters|apps|user_mcps)"/.test(trimmed)) continue;
    await dbWrite.execute(sql.raw(trimmed));
  }
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Affiliate Org", slug: `org-${Date.now()}`, credit_balance: "0.000000" })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: `steward-${Date.now()}`, organization_id: org.id })
    .returning();
  userId = user.id;
}, 300_000);

afterAll(async () => {
  await closeDb?.();
});

test("affiliate Stripe Connect payout is recorded as a redemption, not as un-earning", async () => {
  const { redeemableEarningsService } = await import("./redeemable-earnings");
  const { debitAffiliatePayout } = await import("./affiliate-payouts");

  await redeemableEarningsService.addEarnings({
    userId,
    amount: 100,
    source: "affiliate",
    sourceId: "affiliate-fee-1",
    description: "affiliate fee after retirement",
  });

  await debitAffiliatePayout({
    userId,
    amountUsd: 40,
    idempotencyKey: "payout-key-0000000001",
    description: "Stripe Connect affiliate payout",
    metadata: { payout_method: "stripe_connect" },
  });

  const after = await redeemableEarningsService.getBalance(userId);
  const [row] = await dbWrite
    .select()
    .from(redeemableEarnings)
    .where(eq(redeemableEarnings.user_id, userId));

  expect(after?.availableBalance).toBe(60);
  expect(after?.totalEarned).toBe(100);
  expect(after?.totalRedeemed).toBe(40);
  expect(row.earned_from_affiliates).toBe("100.0000");

  await redeemableEarningsService.addEarnings({
    userId,
    amount: 40,
    source: "affiliate",
    sourceId: "payout-key-0000000001:refund",
    description: "Stripe Connect affiliate payout rejected",
    dedupeBySourceId: true,
    reversesRedemption: true,
  });
  const restored = await redeemableEarningsService.getBalance(userId);
  expect(restored?.availableBalance).toBe(100);
  expect(restored?.totalEarned).toBe(100);
  expect(restored?.totalRedeemed).toBe(0);
}, 300_000);
