/** Real-PGlite proof that dashboard day-bucket token sums survive int4 range. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
const { closeDatabaseConnectionsForTests, dbWrite, getPgliteClientForTests } =
  await import("../../shared/src/db/client");
// drizzle-orm/drizzle-kit install only under cloud-shared, which has no
// package.json route from this tree — so schema push goes through the
// shared re-export whose own imports resolve from its directory.
const { pushSchemaToTestDb } = await import(
  "../../shared/src/db/push-schema-for-tests"
);
const { organizations } = await import(
  "../../shared/src/db/schemas/organizations"
);
const { users } = await import("../../shared/src/db/schemas/users");
const { apiKeys } = await import("../../shared/src/db/schemas/api-keys");
const { usageRecords } = await import(
  "../../shared/src/db/schemas/usage-records"
);
const { loadDashboardInputs } = await import("./dashboard-alerts");

const TIMEOUT = 120_000;
const ORG_ID = "00000000-0000-4000-8000-000000004001";
// Three buckets of 1e9 summable tokens each: the day total lands at 3e9,
// past the int4 ceiling the old ::int casts could not represent (#29771).
const ROW_WIDTH = 1_000_000_000;
const EXPECTED_TOTAL = 3 * ROW_WIDTH;
const DAY = "2026-08-01T12:00:00.000Z";

let server: InstanceType<typeof PGLiteSocketServer> | undefined;
const priorTestDatabaseUrl = process.env.TEST_DATABASE_URL;

beforeAll(async () => {
  await pushSchemaToTestDb({ organizations, users, apiKeys, usageRecords });

  await dbWrite.insert(organizations).values({
    id: ORG_ID,
    name: "dashboard-width-org",
    slug: "dashboard-width-org",
  });
  for (const suffix of [1, 2, 3]) {
    await dbWrite.insert(usageRecords).values({
      organization_id: ORG_ID,
      type: "inference",
      provider: "test-provider",
      input_tokens: ROW_WIDTH,
      output_tokens: ROW_WIDTH,
      input_cost: "1.000000",
      output_cost: "1.000000",
      created_at: new Date(DAY),
      request_id: `dashboard-width-${suffix}`,
    });
  }

  // loadDashboardInputs builds its own pg Pool from TEST_DATABASE_URL, so
  // the shared in-memory PGlite is exposed over the pg wire here; the
  // drizzle seed path above keeps pointing at it directly.
  server = new PGLiteSocketServer({
    db: getPgliteClientForTests(),
    port: 0,
    maxConnections: 4,
  });
  await server.start();
  const conn = server.getServerConn();
  process.env.TEST_DATABASE_URL = `postgres://postgres:postgres@${conn}/postgres`;
}, TIMEOUT);

afterAll(async () => {
  if (priorTestDatabaseUrl === undefined) {
    delete process.env.TEST_DATABASE_URL;
  } else {
    process.env.TEST_DATABASE_URL = priorTestDatabaseUrl;
  }
  await server?.stop();
  await closeDatabaseConnectionsForTests();
});

describe("dashboard-alerts token width (real PGlite over pg wire)", () => {
  test("reports day-bucket token sums past 2^31-1 instead of throwing", async () => {
    const start = new Date("2026-08-01T00:00:00.000Z");
    const end = new Date("2026-08-01T23:59:59.999Z");
    const { historicalData } = await loadDashboardInputs(ORG_ID, start, end);
    expect(historicalData).toHaveLength(1);
    expect(historicalData[0]?.inputTokens).toBe(EXPECTED_TOTAL);
    expect(historicalData[0]?.outputTokens).toBe(EXPECTED_TOTAL);
  });
});
