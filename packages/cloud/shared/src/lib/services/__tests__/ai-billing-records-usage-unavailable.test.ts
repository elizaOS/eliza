/**
 * Real-DB contract for the AI billing ledger row when the usage-analytics
 * insert failed after credits were settled (#31112): the row is still written,
 * with a null usage link and an explicit unavailable marker, and the normal
 * linked row is unchanged. Pushes the real Drizzle schema into in-process
 * PGlite and drives the real repository; nothing on the write path is mocked.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

const USER_ID = "00000000-0000-0000-0000-00000000b113";
const KEY_ID = "00000000-0000-0000-0000-00000000b115";
const ORG_B = "00000000-0000-0000-0000-00000000b116";
const TX_ID = "00000000-0000-0000-0000-00000000b117";
const ORG_ID = "00000000-0000-0000-0000-00000000b112";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let service: typeof import("../ai-billing-records").aiBillingRecordsService;
let recordSettledInferenceBilling: typeof import("../ai-billing-settled").recordSettledInferenceBilling;

const billing = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  inputCost: 0.001,
  outputCost: 0.002,
  totalCost: 0.003,
  baseInputCost: 0.0005,
  baseOutputCost: 0.001,
  baseTotalCost: 0.0015,
  platformMarkup: 2,
  markupApplied: true,
} satisfies import("../ai-billing").BillingResult;

function context(requestId: string): import("../ai-billing").BillingContext {
  return {
    organizationId: ORG_ID,
    userId: USER_ID,
    apiKeyId: null,
    model: "gpt-oss-120b",
    provider: "cerebras",
    requestId,
  };
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  const { pushSchemaToTestDb } = await import("../../../db/push-schema-for-tests");
  // Push the ledger table with its foreign-key closure
  // (usage_records -> api_keys, and every table -> organizations/users).
  const { aiBillingRecords } = await import("../../../db/schemas/ai-billing-records");
  const { organizations } = await import("../../../db/schemas/organizations");
  const { users } = await import("../../../db/schemas/users");
  const { apiKeys } = await import("../../../db/schemas/api-keys");
  const { usageRecords } = await import("../../../db/schemas/usage-records");
  const { creditTransactions } = await import("../../../db/schemas/credit-transactions");
  await pushSchemaToTestDb({
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
  for (const statement of `
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG_B}', 'Second', 'second-${ORG_B}');
    INSERT INTO users (id, organization_id, steward_user_id) VALUES ('${USER_ID}', '${ORG_ID}', 'ledger-fixture');
    INSERT INTO api_keys (id, organization_id, user_id, name, key_hash, key_prefix)
      VALUES ('${KEY_ID}', '${ORG_ID}', '${USER_ID}', 'fixture', 'test-hash', 'test');
    INSERT INTO credit_transactions (id, organization_id, amount, type) VALUES ('${TX_ID}', '${ORG_ID}', '-0.005', 'debit');
  `
    .split(";")
    .filter((sql) => sql.trim()))
    await dbWrite.execute(statement);
  ({ aiBillingRecordsService: service } = await import("../ai-billing-records"));
  ({ recordSettledInferenceBilling } = await import("../ai-billing-settled"));
});

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("aiBillingRecordsService.record without a usage record", () => {
  test("writes the ledger row with a null usage link and an unavailable marker", async () => {
    const row = await service.record({
      context: context("req-no-usage"),
      billing,
      usageRecord: null,
      idempotencyKey: "idem-no-usage",
      reconciliation: null,
    });
    expect(row.usage_record_id).toBeNull();
    expect(row.provider).toBe("cerebras");
    expect(row.status).toBe("recorded");
    expect(row.usage_total_cost).toBe("0.003000");
    expect(row.metadata).toMatchObject({
      usageRecordStatus: "unavailable",
    });

    const stored = await dbWrite.execute(
      `SELECT usage_record_id, idempotency_key FROM ai_billing_records WHERE organization_id = '${ORG_ID}';`,
    );
    expect(stored.rows).toEqual([{ usage_record_id: null, idempotency_key: "idem-no-usage" }]);
  });

  test("still dedupes on the organization idempotency key when the usage link is null", async () => {
    const again = await service.record({
      context: context("req-no-usage"),
      billing,
      usageRecord: null,
      idempotencyKey: "idem-no-usage",
      reconciliation: null,
    });
    const rows = await dbWrite.execute(
      `SELECT count(*)::int AS n FROM ai_billing_records WHERE organization_id = '${ORG_ID}';`,
    );
    expect((rows.rows[0] as { n: number }).n).toBe(1);
    expect(again.metadata).toMatchObject({ usageRecordStatus: "unavailable" });
  });

  test("a linked row keeps the usage id and reports recorded", async () => {
    await dbWrite.execute(
      `INSERT INTO usage_records (id, organization_id, type, model, provider, input_tokens, output_tokens, input_cost, output_cost)
       VALUES ('00000000-0000-0000-0000-00000000b114', '${ORG_ID}', 'chat', 'gpt-oss-120b', 'cerebras', 10, 5, '0.001', '0.002');`,
    );
    const row = await service.record({
      context: context("req-with-usage"),
      billing,
      usageRecord: (await dbWrite.query.usageRecords.findFirst()) ?? null,
      idempotencyKey: "idem-with-usage",
      reconciliation: null,
    });
    expect(row.usage_record_id).toBe("00000000-0000-0000-0000-00000000b114");
    expect(row.metadata).toMatchObject({ usageRecordStatus: "recorded" });
    expect(row.metadata).not.toHaveProperty("usageRecordError");
  });

  test("recordSettledInferenceBilling writes the ledger row when the real usage insert fails", async () => {
    // usage_records.api_key_id references api_keys; an unknown key makes the
    // real analytics insert fail while the ledger row (no api_key column)
    // can still be written.
    const outcome = await recordSettledInferenceBilling({
      context: {
        ...context("req-analytics-down"),
        apiKeyId: "00000000-0000-0000-0000-00000000dead",
      },
      billing,
      reconciliation: null,
      idempotencyKey: "idem-analytics-down",
      analytics: { type: "chat", content: "hi", prompt: "hello" },
    });
    expect(outcome.usageRecord).toBeNull();
    expect(outcome.record.usage_record_id).toBeNull();
    expect(outcome.record.metadata).toMatchObject({ usageRecordStatus: "unavailable" });
    expect(outcome.record.metadata.usageRecordError).toBe("usage_analytics_unavailable");

    const usageRows = await dbWrite.execute(
      `SELECT count(*)::int AS n FROM usage_records WHERE request_id = 'req-analytics-down';`,
    );
    expect((usageRows.rows[0] as { n: number }).n).toBe(0);
  });

  test("preserves the real usage receipt when the later generation table is unavailable", async () => {
    const outcome = await recordSettledInferenceBilling({
      context: { ...context("req-generation-down"), apiKeyId: KEY_ID },
      billing,
      reconciliation: null,
      idempotencyKey: "idem-generation-down",
      analytics: { content: "sensitive response fixture", prompt: "sensitive prompt fixture" },
    });
    expect(outcome.usageRecord?.id).toBeTruthy();
    expect(outcome.record.usage_record_id).toBe(outcome.usageRecord?.id);
    expect(outcome.record.metadata.usageRecordStatus).toBe("recorded");
    expect(outcome.record.metadata).not.toHaveProperty("usageRecordError");
  });

  test("preserves settlement receipts and separates the same key across tenants", async () => {
    const first = await service.record({
      context: context("receipt"),
      billing,
      usageRecord: null,
      idempotencyKey: "shared-key",
      reconciliation: {
        reservedAmount: 0.01,
        actualCost: 0.005,
        reservationTransactionId: TX_ID,
        settlementTransactionIds: [TX_ID],
        adjustmentType: "refund",
      },
    });
    const second = await service.record({
      context: { ...context("second"), organizationId: ORG_B },
      billing,
      usageRecord: null,
      idempotencyKey: "shared-key",
      reconciliation: null,
    });
    expect(first.id).not.toBe(second.id);
    expect(first.ledger_total).toBe("0.005000");
    expect(first.usage_total_cost).toBe("0.003000");
    expect(first.reservation_transaction_id).toBe(TX_ID);
    expect(first.settlement_transaction_ids).toEqual([TX_ID]);
  });

  test("does not invent the provider for an unknown custom model", async () => {
    const row = await service.record({
      context: { ...context("unknown"), provider: undefined, model: "custom-model" },
      billing,
      usageRecord: null,
      idempotencyKey: "unknown",
      reconciliation: null,
    });
    expect(row.provider).toBe("unknown");
  });

  test("propagates a ledger failure after analytics without fabricating a receipt", async () => {
    await expect(
      recordSettledInferenceBilling({
        context: context("bad-ledger"),
        billing,
        idempotencyKey: "bad-ledger",
        reconciliation: {
          reservedAmount: 0.01,
          actualCost: 0.003,
          reservationTransactionId: "00000000-0000-0000-0000-00000000dead",
          settlementTransactionIds: [],
          adjustmentType: "refund",
        },
        analytics: {},
      }),
    ).rejects.toThrow();
    const rows = await dbWrite.execute(
      "SELECT id FROM ai_billing_records WHERE idempotency_key = 'bad-ledger'",
    );
    expect(rows.rows).toEqual([]);
    const usage = await dbWrite.execute(
      "SELECT id FROM usage_records WHERE request_id = 'bad-ledger'",
    );
    expect(usage.rows).toHaveLength(1);
  });

  test("recordSettledInferenceBilling links the usage row when analytics succeeds", async () => {
    const outcome = await recordSettledInferenceBilling({
      context: context("req-analytics-ok"),
      billing,
      reconciliation: null,
      idempotencyKey: "idem-analytics-ok",
      analytics: { type: "chat", content: "hi", prompt: "hello" },
    });
    expect(outcome.usageRecord?.id).toBeTruthy();
    expect(outcome.record.usage_record_id).toBe(outcome.usageRecord?.id ?? "");
    expect(outcome.record.metadata).toMatchObject({ usageRecordStatus: "recorded" });
  });
});
