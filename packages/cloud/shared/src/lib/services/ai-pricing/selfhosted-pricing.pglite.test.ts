/** Exercises offline tariff resolution and source-scoped refresh against real PostgreSQL-compatible storage. */
import { afterAll, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../../../db/schemas/ai-pricing";

const client = new PGlite();
const database = drizzle(client, { schema });
mock.module("../../../db/helpers", () => ({ dbRead: database, dbWrite: database }));
const originalFetch = globalThis.fetch;
let networkRequests = 0;
globalThis.fetch = (() => {
  networkRequests++;
  throw new Error("No external catalog is available in this fixture");
}) as typeof fetch;
const { calculateTextCostFromCatalog } = await import("./lookup");
const { refreshPricingCatalog } = await import("./refresh");
const { toDbEntry } = await import("./dimensions");
const { fetchCloudflareEmbeddingEntries } = await import("./providers/cloudflare");
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await client.close();
});

test("selfhosted BGE prices and refreshes without an external catalog, preserving other sources", async () => {
  const { apply } = await pushSchema(schema as never, database as never);
  await apply();
  for (const [model, inputTokens, expected] of [
    ["bge-small-en-v1.5", 1_000_000, 0.005],
    ["selfhosted/bge-small-en-v1.5", 500_000, 0.0025],
  ] as const) {
    const cost = await calculateTextCostFromCatalog({
      model,
      inputTokens,
      outputTokens: 0,
      provider: "selfhosted",
      billingSource: "selfhosted",
    });
    expect(cost.baseInputCost).toBe(expected);
    expect(cost.baseOutputCost).toBe(0);
  }
  const cloudflare = await calculateTextCostFromCatalog({
    model: "bge-small-en-v1.5",
    inputTokens: 1_000_000,
    outputTokens: 0,
    provider: "cloudflare",
    billingSource: "cloudflare",
  });
  expect(cloudflare.baseInputCost).toBe(0.0202);

  const [otherSource] = await database
    .insert(schema.aiPricingEntries)
    .values(toDbEntry(fetchCloudflareEmbeddingEntries()[0], new Date()))
    .returning();
  const first = await refreshPricingCatalog(["selfhosted"]);
  expect(first.success).toBe(true);
  const firstRows = await database
    .select()
    .from(schema.aiPricingEntries)
    .where(eq(schema.aiPricingEntries.source_kind, "selfhosted_platform_snapshot"));
  expect(
    firstRows.some(
      (row) =>
        row.model === "bge-small-en-v1.5" &&
        row.charge_type === "input" &&
        Number(row.unit_price) === 0.000000005 &&
        row.is_active,
    ),
  ).toBe(true);

  const second = await refreshPricingCatalog(["selfhosted"]);
  expect(second.success).toBe(true);
  const all = await database.select().from(schema.aiPricingEntries);
  expect(all.find((row) => row.id === otherSource.id)).toEqual(otherSource);
  for (const previous of firstRows) {
    expect(all.find((row) => row.id === previous.id)?.is_active).toBe(false);
    expect(
      all.filter(
        (row) =>
          row.is_active &&
          row.provider === previous.provider &&
          row.model === previous.model &&
          row.charge_type === previous.charge_type,
      ),
    ).toHaveLength(1);
  }
  const runs = await database.select().from(schema.aiPricingRefreshRuns);
  expect(runs).toHaveLength(2);
  expect(runs.every((run) => run.source === "selfhosted" && run.status === "completed")).toBe(true);
  expect(networkRequests).toBe(0);
}, 60_000);
