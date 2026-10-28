/**
 * The broadcast-batch backstop re-checks payments the user already broadcast.
 * A payment whose verify keeps failing on a transient RPC error stays in
 * `broadcast` and gets its `updated_at` bumped on every tick, so it must not
 * keep occupying the bounded batch ahead of deposits that have not been
 * checked yet. Real PGlite; the on-chain verify is stubbed.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
setDefaultTimeout(120_000);

const { closeDatabaseConnectionsForTests, dbWrite } = await import("../../../db/client");
const { pushSchemaToTestDb } = await import("../../../db/push-schema-for-tests");
const { cryptoPayments } = await import("../../../db/schemas/crypto-payments");
const { organizations } = await import("../../../db/schemas/organizations");
const { users } = await import("../../../db/schemas/users");
const { directWalletPaymentsService } = await import("../direct-wallet-payments");

const T0 = new Date("2026-10-01T00:00:00.000Z");

beforeAll(async () => {
  await pushSchemaToTestDb({ cryptoPayments, organizations, users });
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function seedBroadcastPayment(updatedAt: Date, verifyAttempts: number): Promise<string> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const paymentId = randomUUID();
  await dbWrite.insert(organizations).values({
    id: orgId,
    name: `Buyer ${orgId}`,
    slug: `buyer-${orgId}`,
  });
  await dbWrite.insert(users).values({
    id: userId,
    organization_id: orgId,
    steward_user_id: `subject_${userId}`,
    role: "owner",
  });
  await dbWrite.insert(cryptoPayments).values({
    id: paymentId,
    organization_id: orgId,
    user_id: userId,
    payment_address: `0x${paymentId.replaceAll("-", "").padEnd(40, "0")}`,
    token: "USDC",
    network: "BASE",
    expected_amount: "10",
    credits_to_add: "10",
    transaction_hash: `0x${paymentId.replaceAll("-", "").padEnd(64, "0")}`,
    status: "broadcast",
    created_at: updatedAt,
    updated_at: updatedAt,
    expires_at: new Date(T0.getTime() + 3_600_000),
    metadata: {
      kind: "direct_wallet_credit_purchase",
      verify_attempts: verifyAttempts,
    },
  });
  return paymentId;
}

test("a payment retried every tick does not keep a slot from an unchecked deposit", async () => {
  // The retried row sorts first physically: it is written by every pass and its
  // `updated_at` is therefore the newest.
  const retried = await seedBroadcastPayment(new Date(T0.getTime() + 120 * 60_000), 30);
  const older = await seedBroadcastPayment(new Date(T0.getTime() + 10 * 60_000), 0);
  const newer = await seedBroadcastPayment(new Date(T0.getTime() + 20 * 60_000), 0);

  const checked: string[] = [];
  spyOn(directWalletPaymentsService, "confirmPayment").mockImplementation(async (_env, params) => {
    checked.push(params.paymentId);
    throw new Error("RPC request failed: 503 Service Unavailable");
  });

  const stats = await directWalletPaymentsService.processBroadcastBatch({} as never, {
    batchSize: 2,
  });

  expect(stats.processed).toBe(2);
  expect(checked).toEqual([older, newer]);
  expect(checked).not.toContain(retried);
});
