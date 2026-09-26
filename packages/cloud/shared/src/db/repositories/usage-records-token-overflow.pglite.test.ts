/**
 * Guards usage-token aggregation against overflow through the real repository
 * SQL against an in-memory PGlite database.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { usageRecords } from "../schemas/usage-records";

const client = new PGlite();
const database = drizzle({ client, schema: { usageRecords } });

mock.module("../helpers", () => ({
  dbRead: database,
  dbWrite: database,
}));

const { UsageRecordsRepository } = await import("./usage-records");

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";

describe("UsageRecordsRepository token aggregation", () => {
  beforeAll(async () => {
    await client.exec(`
      create table usage_records (
        organization_id uuid not null,
        provider text not null,
        canonical_provider text not null,
        input_tokens integer not null,
        output_tokens integer not null,
        input_cost numeric not null,
        output_cost numeric not null,
        is_successful boolean not null
      );

      insert into usage_records (
        organization_id,
        provider,
        canonical_provider,
        input_tokens,
        output_tokens,
        input_cost,
        output_cost,
        is_successful
      ) values
        ('${ORGANIZATION_ID}', 'openai', 'openai', 1000000000, 10, 1, 1, true),
        ('${ORGANIZATION_ID}', 'openai', 'openai', 1000000000, 10, 1, 1, true),
        ('${ORGANIZATION_ID}', 'openai', 'openai', 1000000000, 10, 1, 1, true);
    `);
  });

  afterAll(async () => {
    await client.close();
  });

  test("getStatsByOrganization sums 3e9 input tokens without overflow", async () => {
    const stats = await new UsageRecordsRepository().getStatsByOrganization(ORGANIZATION_ID);

    expect(stats.totalInputTokens).toBe(3_000_000_000);
  });

  test("getProviderBreakdown sums 3e9 tokens without overflow", async () => {
    const breakdown = await new UsageRecordsRepository().getProviderBreakdown(ORGANIZATION_ID);

    expect(breakdown[0]?.totalTokens).toBe(3_000_000_030);
  });
});
