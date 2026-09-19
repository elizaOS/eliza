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
} as unknown as import("../ai-billing").BillingResult;

function context(requestId: string): import("../ai-billing").BillingContext {
  return {
    organizationId: ORG_ID,
    // No users row is seeded; the ledger keeps user_id nullable (set null on delete).
    userId: null,
    apiKeyId: null,
    model: "gpt-oss-120b",
    provider: "cerebras",
    requestId,
  } as unknown as import("../ai-billing").BillingContext;
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
      usageRecordError: "usage_records insert failed: connection reset",
      idempotencyKey: "idem-no-usage",
      reconciliation: null,
    });
    expect(row.usage_record_id).toBeNull();
    expect(row.provider).toBe("cerebras");
    expect(row.status).toBe("recorded");
    expect(row.usage_total_cost).toBe("0.003000");
    expect(row.metadata).toMatchObject({
      usageRecordStatus: "unavailable",
      usageRecordError: "usage_records insert failed: connection reset",
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
      usageRecord: {
        id: "00000000-0000-0000-0000-00000000b114",
        provider: "cerebras",
      } as unknown as import("../../../db/repositories").UsageRecord,
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
      } as unknown as import("../ai-billing").BillingContext,
      billing,
      reconciliation: null,
      idempotencyKey: "idem-analytics-down",
      analytics: { type: "chat", content: "hi", prompt: "hello" },
    });
    expect(outcome.usageRecord).toBeNull();
    expect(outcome.record.usage_record_id).toBeNull();
    expect(outcome.record.metadata).toMatchObject({ usageRecordStatus: "unavailable" });
    expect(String((outcome.record.metadata as Record<string, unknown>).usageRecordError)).toMatch(
      /api_key|foreign key|violates/i,
    );

    const usageRows = await dbWrite.execute(
      `SELECT count(*)::int AS n FROM usage_records WHERE request_id = 'req-analytics-down';`,
    );
    expect((usageRows.rows[0] as { n: number }).n).toBe(0);
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
