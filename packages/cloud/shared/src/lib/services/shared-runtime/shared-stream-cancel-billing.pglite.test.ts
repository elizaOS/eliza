/**
 * An org-funded Shared stream the consumer cancels is billed for the reply it
 * already delivered, not for the admitted 500-token output estimate. Real
 * pricing, billing and ledger rows on PGlite; only the reservation settlers
 * are observed (first call wins, as in production).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

const ORG_ID = "00000000-0000-0000-0000-00000000d001";
const USER_ID = "00000000-0000-0000-0000-00000000d002";
const MODEL = "anthropic/claude-sonnet-4-6";
const OUTPUT_PRICE = 15e-6;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  const { pushSchemaToTestDb } = await import("../../../db/push-schema-for-tests");
  const { aiPricingEntries } = await import("../../../db/schemas/ai-pricing");
  const { aiBillingRecords } = await import("../../../db/schemas/ai-billing-records");
  const { organizations } = await import("../../../db/schemas/organizations");
  const { users } = await import("../../../db/schemas/users");
  const { apiKeys } = await import("../../../db/schemas/api-keys");
  const { usageRecords } = await import("../../../db/schemas/usage-records");
  const { creditTransactions } = await import("../../../db/schemas/credit-transactions");
  await pushSchemaToTestDb({
    aiPricingEntries,
    organizations,
    users,
    apiKeys,
    usageRecords,
    creditTransactions,
    aiBillingRecords,
  });
  await dbWrite.execute(
    `INSERT INTO organizations (id, name, slug) VALUES ('${ORG_ID}', 'Acme', 'acme-${ORG_ID}');`,
  );
  await dbWrite.execute(
    `INSERT INTO users (id, organization_id, steward_user_id) VALUES ('${USER_ID}', '${ORG_ID}', 'shared-cancel');`,
  );
  const { aiPricingRepository } = await import("../../../db/repositories/ai-pricing");
  for (const [chargeType, unitPrice] of [
    ["input", 3e-6],
    ["output", OUTPUT_PRICE],
  ] as const) {
    await aiPricingRepository.createManualOverride({
      billingSource: "bitrouter",
      provider: "anthropic",
      model: MODEL,
      productFamily: "language",
      chargeType,
      unit: "token",
      unitPrice,
      dimensionKey: "*",
      dimensions: {},
      reason: "test: isolated prices",
      updatedBy: "test",
    });
  }
});

afterAll(async () => {
  if (closeDb) await closeDb();
});

function observedBilling(requestId: string) {
  const outcome: { exact: number[]; unknown: number } = { exact: [], unknown: 0 };
  let settled = false;
  const billing = {
    context: {
      organizationId: ORG_ID,
      userId: USER_ID,
      apiKeyId: null,
      model: MODEL,
      provider: "anthropic",
      billingSource: "bitrouter" as const,
      requestId,
    },
    idempotencyKey: `idem-${requestId}`,
    estimatedInputTokens: 20,
    reservation: undefined,
    settle: async (amount: number) => {
      if (settled) return null;
      settled = true;
      outcome.exact.push(amount);
      return null;
    },
    settleUnknown: async () => {
      if (settled) return null;
      settled = true;
      outcome.unknown += 1;
      return null;
    },
    markProviderDispatched: () => {},
  };
  return { billing, outcome };
}

type SettleArgs = Parameters<
  typeof import("./shared-runtime-chat").__sharedStreamSettlementTestHooks.settleInterruptedProviderWork
>;

test("a canceled stream is billed for the reply it delivered", async () => {
  const { __sharedStreamSettlementTestHooks } = await import("./shared-runtime-chat");
  const { estimateInputTokens } = await import("../ai-billing");
  const delivered = "The quick brown fox jumps over the lazy dog. ".repeat(400);
  const deliveredTokens = estimateInputTokens([{ content: delivered }]);
  expect(deliveredTokens).toBeGreaterThan(2_000);

  const { billing, outcome } = observedBilling("shared-cancel-delivered");
  await __sharedStreamSettlementTestHooks.settleInterruptedProviderWork(
    { id: "agent-shared-cancel" } as SettleArgs[0],
    billing as SettleArgs[1],
    delivered,
    "write a long report",
    "consumer canceled stream",
  );

  expect(outcome.unknown).toBe(0);
  expect(outcome.exact).toHaveLength(1);
  expect(outcome.exact[0]).toBeGreaterThanOrEqual(deliveredTokens * OUTPUT_PRICE);
  expect(outcome.exact[0]).toBeGreaterThan(500 * OUTPUT_PRICE * 4);
  const rows = await dbWrite.execute(
    `SELECT usage_total_cost, idempotency_key FROM ai_billing_records WHERE organization_id = '${ORG_ID}';`,
  );
  expect(rows.rows).toHaveLength(1);
  const [row] = rows.rows as Array<{ usage_total_cost: string; idempotency_key: string }>;
  expect(row.idempotency_key).toBe("idem-shared-cancel-delivered");
  expect(Number(row.usage_total_cost)).toBeCloseTo(outcome.exact[0], 5);
});

test("a stream canceled within the admitted estimate keeps the estimate", async () => {
  const { __sharedStreamSettlementTestHooks } = await import("./shared-runtime-chat");
  const { billing, outcome } = observedBilling("shared-cancel-short");
  await __sharedStreamSettlementTestHooks.settleInterruptedProviderWork(
    { id: "agent-shared-cancel" } as SettleArgs[0],
    billing as SettleArgs[1],
    "A short start.",
    "write a long report",
    "consumer canceled stream",
  );
  expect(outcome.exact).toEqual([]);
  expect(outcome.unknown).toBe(1);
});
