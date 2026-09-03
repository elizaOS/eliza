/**
 * Lifetime usage aggregates past 2^31-1 tokens (real PGlite).
 *
 * `input_tokens` and `output_tokens` are `integer` columns, so Postgres types
 * `sum()` over them as `bigint`. Narrowing those aggregates back to `::int`
 * raises `integer out of range` (SQLSTATE 22003) once the summed total crosses
 * 2,147,483,647 — and because every date window on these methods is optional,
 * an omitted window makes the sum lifetime-wide and the failure permanent.
 *
 * The harness is real: the actual repository SQL runs against in-process
 * PGlite. The trailing loud guard fails the suite if PGlite never initialized,
 * so the database cases can never pass vacuously.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { types as pgTypes } from "pg";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const PGLITE_TIMEOUT = 60000;
const ORGANIZATION_ID = "00000000-0000-0000-0000-0000000000e1";
const USER_ID = "00000000-0000-0000-0000-0000000000e2";
// Three rows of 800M input and 800M output: 2.4B per direction and 4.8B
// combined, both past the int32 ceiling the `::int` casts could represent.
const ROW_TOKENS = 800_000_000;
const ROWS = 3;
const EXPECTED_PER_DIRECTION = ROWS * ROW_TOKENS;
const EXPECTED_COMBINED = EXPECTED_PER_DIRECTION * 2;

let dbWrite: typeof import("../../client").dbWrite;
let closeDb: typeof import("../../client").closeDatabaseConnectionsForTests | undefined;
let usageRecordsRepository: typeof import("../usage-records").usageRecordsRepository;
let pgliteReady = true;

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../client"));
    ({ usageRecordsRepository } = await import("../usage-records"));
    // Hand-rolled minimal DDL (the sibling redeemable-earnings pattern): the
    // real schema's FK chain pulls in the whole graph, which these read-only
    // aggregates do not exercise. `canonical_provider` is generated exactly as
    // production generates it, because the provider breakdown groups on it.
    await dbWrite.execute(`CREATE TABLE IF NOT EXISTS usage_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      user_id uuid,
      api_key_id uuid,
      type text NOT NULL,
      model text,
      provider text NOT NULL,
      input_tokens integer NOT NULL DEFAULT 0,
      output_tokens integer NOT NULL DEFAULT 0,
      input_cost numeric(16,6) DEFAULT '0.000000',
      output_cost numeric(16,6) DEFAULT '0.000000',
      markup numeric(16,6) DEFAULT '0.000000',
      request_id text,
      duration_ms integer,
      is_successful boolean NOT NULL DEFAULT true,
      error_message text,
      ip_address text,
      user_agent text,
      metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamp NOT NULL DEFAULT now(),
      canonical_model text GENERATED ALWAYS AS (CASE
        WHEN model IS NULL OR model::text = '' THEN '__null__'
        WHEN position('/'::text in (model::text)) > 0 THEN
          CASE
            WHEN model::text LIKE 'xai/%' THEN 'x-ai/' || substring(model::text from 5)
            WHEN model::text LIKE 'mistral/%' THEN 'mistralai/' || substring(model::text from 9)
            ELSE model
          END
        ELSE model
      END) STORED,
      canonical_provider text GENERATED ALWAYS AS (CASE provider
        WHEN 'x-ai' THEN 'xai'
        WHEN 'mistralai' THEN 'mistral'
        ELSE provider
      END) STORED
    )`);
    await dbWrite.execute(`CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY,
      name text,
      email text
    )`);
    await dbWrite.execute(
      `INSERT INTO users (id, name, email) VALUES ('${USER_ID}', 'Wide User', 'wide@example.test')`,
    );
    for (let index = 0; index < ROWS; index += 1) {
      await dbWrite.execute(
        `INSERT INTO usage_records
           (organization_id, user_id, type, model, provider, input_tokens, output_tokens, input_cost, output_cost)
         VALUES ('${ORGANIZATION_ID}', '${USER_ID}', 'completion', 'claude-opus-4', 'anthropic',
                 ${ROW_TOKENS}, ${ROW_TOKENS}, '1.000000', '1.000000')`,
      );
    }
  } catch (error) {
    pgliteReady = false;
    console.warn("[usage-records-token-width] PGlite unavailable:", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

test(
  "getStatsByOrganization reports lifetime token totals past 2^31-1",
  async () => {
    if (!pgliteReady) return;

    // No date arguments: this is the lifetime window that overflows.
    const stats = await usageRecordsRepository.getStatsByOrganization(ORGANIZATION_ID);

    expect(stats.totalRequests).toBe(ROWS);
    expect(stats.totalInputTokens).toBe(EXPECTED_PER_DIRECTION);
    expect(stats.totalOutputTokens).toBe(EXPECTED_PER_DIRECTION);
    // Numbers, not the strings a bigint cell arrives as.
    expect(typeof stats.totalInputTokens).toBe("number");
    expect(typeof stats.totalOutputTokens).toBe("number");
  },
  PGLITE_TIMEOUT,
);

test(
  "getProviderBreakdown sums input and output past 2^31-1 within one group",
  async () => {
    if (!pgliteReady) return;

    const breakdown = await usageRecordsRepository.getProviderBreakdown(ORGANIZATION_ID);

    expect(breakdown).toHaveLength(1);
    expect(breakdown[0]?.provider).toBe("anthropic");
    expect(breakdown[0]?.totalTokens).toBe(EXPECTED_COMBINED);
    expect(typeof breakdown[0]?.totalTokens).toBe("number");
  },
  PGLITE_TIMEOUT,
);

test(
  "getUsageByUser sums one user's lifetime tokens past 2^31-1",
  async () => {
    if (!pgliteReady) return;

    const consumers = await usageRecordsRepository.getUsageByUser(ORGANIZATION_ID);

    expect(consumers).toHaveLength(1);
    expect(consumers[0]?.userId).toBe(USER_ID);
    expect(consumers[0]?.inputTokens).toBe(EXPECTED_PER_DIRECTION);
    expect(consumers[0]?.outputTokens).toBe(EXPECTED_PER_DIRECTION);
    expect(typeof consumers[0]?.inputTokens).toBe("number");
  },
  PGLITE_TIMEOUT,
);

test(
  "getUsageTimeSeries overflows too: a required window is not a bound",
  async () => {
    if (!pgliteReady) return;

    // This method is the one that always requires both dates, which is easy to
    // mistake for safety. It is not: the ceiling is on the summed total, not on
    // the time span, so any window wide enough to cover 2^31-1 tokens overflows
    // exactly the same way. This case uses a two-hour window to show that.
    const series = await usageRecordsRepository.getUsageTimeSeries(ORGANIZATION_ID, {
      startDate: new Date(Date.now() - 60 * 60 * 1000),
      endDate: new Date(Date.now() + 60 * 60 * 1000),
      granularity: "day",
    });

    const inputTotal = series.reduce((sum, point) => sum + point.inputTokens, 0);
    expect(inputTotal).toBe(EXPECTED_PER_DIRECTION);
    expect(typeof series[0]?.inputTokens).toBe("number");
  },
  PGLITE_TIMEOUT,
);

test(
  "getModelBreakdown sums one model's lifetime tokens past 2^31-1",
  async () => {
    if (!pgliteReady) return;

    const models = await usageRecordsRepository.getModelBreakdown(ORGANIZATION_ID);

    expect(models).toHaveLength(1);
    expect(models[0]?.totalTokens).toBe(EXPECTED_COMBINED);
    // avgCostPerToken divides by the total, so an overflowed total would also
    // corrupt this even if the query somehow returned.
    expect(models[0]?.avgCostPerToken).toBeCloseTo(models[0]!.totalCost / EXPECTED_COMBINED, 12);
  },
  PGLITE_TIMEOUT,
);

test(
  "getCostBreakdown sums past 2^31-1 for every dimension it groups by",
  async () => {
    if (!pgliteReady) return;

    for (const dimension of ["model", "provider", "user", "apiKey"] as const) {
      const rows = await usageRecordsRepository.getCostBreakdown(ORGANIZATION_ID, dimension);
      const tokens = rows.reduce((sum, row) => sum + row.tokens, 0);
      expect(tokens).toBe(EXPECTED_COMBINED);
    }
  },
  PGLITE_TIMEOUT,
);

test(
  "cost aggregates arrive as NUMERIC strings, so their conversions are load-bearing",
  async () => {
    if (!pgliteReady) return;

    // Measured, not assumed. Under this driver a `numeric` column comes back as
    // a STRING while a `bigint` comes back as a number, so the `Number(...)` on
    // the cost columns is the conversion that actually does work. Summing is
    // the assertion that catches it: `"3.000000" + "3.000000"` concatenates.
    const stats = await usageRecordsRepository.getStatsByOrganization(ORGANIZATION_ID);
    expect(typeof stats.totalCost).toBe("number");
    expect(stats.totalCost).toBeCloseTo(ROWS * 2, 6);

    const models = await usageRecordsRepository.getModelBreakdown(ORGANIZATION_ID);
    const summedCost = models.reduce((total, row) => total + row.totalCost, 0);
    expect(typeof summedCost).toBe("number");
    expect(summedCost).toBeCloseTo(ROWS * 2, 6);
  },
  PGLITE_TIMEOUT,
);

test("driver type mapping, measured across all three paths this repo can take", async () => {
  // Recorded because the reason for each `Number(...)` differs by column type,
  // and the obvious assumption is wrong. `pg`'s DEFAULT int8 parser returns a
  // string — but drizzle's node-postgres driver installs its own, so a widened
  // `::bigint` sum reaches this repository as a number either way:
  //
  //   direct PGlite      bigint -> number   numeric -> string   int4 -> number
  //   drizzle over pg    bigint -> number   numeric -> string   int4 -> number
  //   raw pg.Pool        bigint -> string
  //
  // So `Number(...)` on the token sums is defensive (it protects the raw-Pool
  // shape, which `packages/cloud/scripts/eliza1/dashboard-alerts.ts` does use),
  // while `Number(...)` on the cost columns is load-bearing here and now. The
  // node-postgres default is pinned so a future driver change is visible.
  const parseInt8 = pgTypes.getTypeParser(20);
  const parseInt4 = pgTypes.getTypeParser(23);
  expect(typeof parseInt8("2400000000")).toBe("string");
  expect(typeof parseInt4("42")).toBe("number");

  if (!pgliteReady) return;
  const row: Record<string, unknown> = await dbWrite
    .execute(`SELECT sum(input_tokens)::bigint AS b,
                     sum(input_cost)::numeric AS c,
                     count(*)::int AS i
              FROM usage_records`)
    .then((result: unknown) => {
      const rows = (result as { rows?: Record<string, unknown>[] }).rows;
      return (rows ?? (result as Record<string, unknown>[]))[0];
    });
  expect(typeof row.b).toBe("number");
  expect(typeof row.c).toBe("string");
  expect(typeof row.i).toBe("number");
});

// Loud guard: PGlite is in-process (no network), so `pgliteReady` must be true.
// Without this a broken import or failed DDL would skip every case above and
// the suite would pass vacuously.
test("PGlite harness initialized (DB cases above are not vacuous)", () => {
  expect(pgliteReady).toBe(true);
});
