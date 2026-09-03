/** Real-PGlite proof that dashboard day-bucket token sums survive int4 range. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const { PGlite } = await import("@electric-sql/pglite");
const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
const { drizzle } = await import("drizzle-orm/pglite");
const { pushSchema } = await import("drizzle-kit/api");
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

let db: ReturnType<typeof drizzle>;
let client: InstanceType<typeof PGlite>;
let server: InstanceType<typeof PGLiteSocketServer> | undefined;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client);
  const { apply } = await pushSchema(
    { organizations, users, apiKeys, usageRecords } as never,
    db as never,
  );
  await apply();

  await db.insert(organizations).values({
    id: ORG_ID,
    name: "dashboard-width-org",
    slug: "dashboard-width-org",
  });
  for (const suffix of [1, 2, 3]) {
    await db.insert(usageRecords).values({
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

  server = new PGLiteSocketServer({ db: client, port: 0, maxConnections: 4 });
  await server.start();
  const conn = server.getServerConn();
  process.env.TEST_DATABASE_URL = `postgres://postgres:postgres@${conn}/postgres`;
}, TIMEOUT);

afterAll(async () => {
  delete process.env.TEST_DATABASE_URL;
  await server?.stop();
  await client?.close();
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
