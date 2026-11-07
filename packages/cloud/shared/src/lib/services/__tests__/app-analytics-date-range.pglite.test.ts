/**
 * App analytics read a date-only end_date as the whole day, and the request
 * timeline groups by period on Postgres.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const ORG = "10000000-0000-4000-8000-0000000000a1";
const USER = "20000000-0000-4000-8000-0000000000a1";
const APP = "30000000-0000-4000-8000-0000000000a1";

let client: typeof import("../../../db/client");

beforeAll(async () => {
  const { pushSchema } = await import("drizzle-kit/api");
  const appsSchema = await import("../../../db/schemas/apps");
  const { organizations } = await import("../../../db/schemas/organizations");
  const { users } = await import("../../../db/schemas/users");
  client = await import("../../../db/client");
  const { apply } = await pushSchema(
    {
      organizations,
      users,
      appDeploymentStatusEnum: appsSchema.appDeploymentStatusEnum,
      userDatabaseStatusEnum: appsSchema.userDatabaseStatusEnum,
      appReviewStatusEnum: appsSchema.appReviewStatusEnum,
      apps: appsSchema.apps,
      appRequests: appsSchema.appRequests,
    } as never,
    client.dbWrite as never,
  );
  await apply();
  await client.dbWrite.insert(organizations).values({ id: ORG, name: "Org", slug: "org" });
  await client.dbWrite
    .insert(users)
    .values({ id: USER, steward_user_id: "u", organization_id: ORG });
  await client.dbWrite.insert(appsSchema.apps).values({
    id: APP,
    name: "App",
    slug: "app",
    organization_id: ORG,
    created_by_user_id: USER,
    app_url: "https://app.example.com",
  });
  const request = (iso: string) => ({
    app_id: APP,
    request_type: "chat",
    source: "api_key",
    ip_address: "1.1.1.1",
    metadata: {},
    created_at: new Date(iso),
  });
  await client.dbWrite
    .insert(appsSchema.appRequests)
    .values([
      request("2026-10-09T12:00:00Z"),
      request("2026-10-10T09:00:00Z"),
      request("2026-10-10T13:00:00Z"),
      request("2026-10-10T22:00:00Z"),
    ]);
});

afterAll(async () => {
  await client?.closeDatabaseConnectionsForTests?.();
});

test("a date-only end_date includes the whole end day", async () => {
  const { parseDateRangeParams } = await import("../../api/date-range-params");
  const { appsRepository } = await import("../../../db/repositories/apps");
  const range = parseDateRangeParams(
    new URLSearchParams("start_date=2026-10-10&end_date=2026-10-10"),
  );
  if (!range.success || !range.startDate || !range.endDate) {
    throw new Error("expected a valid range");
  }
  const logs = await appsRepository.getRecentRequests(APP, {
    startDate: range.startDate,
    endDate: range.endDate,
  });
  expect(logs.total).toBe(3);
});

test("the request timeline groups by period", async () => {
  const { appsRepository } = await import("../../../db/repositories/apps");
  const timeline = await appsRepository.getRequestsOverTime(
    APP,
    "daily",
    new Date("2026-10-09T00:00:00Z"),
    new Date("2026-10-10T23:59:59.999Z"),
  );
  expect(timeline.map((row) => [row.period, row.count])).toEqual([
    ["2026-10-09", 1],
    ["2026-10-10", 3],
  ]);
});
