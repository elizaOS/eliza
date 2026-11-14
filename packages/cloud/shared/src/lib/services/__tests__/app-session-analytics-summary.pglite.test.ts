/**
 * The Sessions tab summary must count every page view in the range. It was
 * computed from a bounded scan of the newest page views (5000), so an app with
 * more page views showed only part of its totals, and sessions cut by the
 * scan counted as bounces. The SQL summary must group exactly like
 * `buildSessionAnalytics`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import {
  appDeploymentStatusEnum,
  appRequests,
  appReviewStatusEnum,
  apps,
  userDatabaseStatusEnum,
} from "../../../db/schemas/apps";
import { organizations } from "../../../db/schemas/organizations";
import { users } from "../../../db/schemas/users";

const ORG = "10000000-0000-4000-8000-0000000000a1";
const USER = "20000000-0000-4000-8000-0000000000a1";
const APP = "30000000-0000-4000-8000-0000000000a1";

let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let service: typeof import("../app-analytics").appAnalyticsService;
let allRows: Awaited<
  ReturnType<typeof import("../../../db/repositories/apps").appsRepository.getRecentRequests>
>["requests"];

beforeAll(async () => {
  const client = await import("../../../db/client");
  closeDb = client.closeDatabaseConnectionsForTests;
  service = (await import("../app-analytics")).appAnalyticsService;
  const { appsRepository } = await import("../../../db/repositories/apps");
  const { apply } = await pushSchema(
    {
      organizations,
      users,
      appDeploymentStatusEnum,
      userDatabaseStatusEnum,
      appReviewStatusEnum,
      apps,
      appRequests,
    } as never,
    client.dbWrite as never,
  );
  await apply();
  await client.dbWrite.insert(organizations).values({ id: ORG, name: "Org", slug: "org" });
  await client.dbWrite
    .insert(users)
    .values({ id: USER, steward_user_id: "analytics-user", organization_id: ORG });
  await client.dbWrite.insert(apps).values({
    id: APP,
    name: "App",
    slug: "app",
    organization_id: ORG,
    created_by_user_id: USER,
    app_url: "https://app.example.com",
  });

  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, 0) + minutes * 60_000);
  const view = (minutes: number, metadata: Record<string, unknown>, ip: string | null = null) => ({
    app_id: APP,
    request_type: "pageview",
    source: "web",
    ip_address: ip,
    metadata,
    created_at: at(minutes),
  });
  await client.dbWrite.insert(appRequests).values([
    // Explicit sessions: three pages, then a bounce.
    view(0, { session_id: "s1", visitor_id: "v1", pathname: "/" }),
    view(2, { session_id: "s1", visitor_id: "v1", pathname: "/pricing" }),
    view(5, { session_id: "s1", visitor_id: "v1", pathname: "/signup" }),
    view(7, { session_id: "s2", visitor_id: "v2", pathname: "/" }),
    // No session id: visitor + UTC hour, across two hours.
    view(10, { visitor_id: "v3", pathname: "/" }),
    view(20, { visitor_id: "v3", pathname: "/docs" }),
    view(70, { visitor_id: "v3", pathname: "/" }),
    // Only an IP; a numeric visitor id is ignored like in the JS grouping.
    view(15, { pathname: "/" }, "203.0.113.9"),
    view(16, { visitor_id: 42, pathname: "/about" }, "203.0.113.9"),
    // Blank strings fall through to the next identity.
    view(30, { session_id: "  ", visitor_id: "v4", pathname: "/" }),
  ]);
  allRows = (await appsRepository.getRecentRequests(APP, { requestType: "pageview", limit: 1000 }))
    .requests;
});

afterAll(async () => {
  await closeDb?.();
});

test("the SQL summary groups sessions exactly like the in-memory analytics", async () => {
  const expected = service.buildSessionAnalytics(allRows).summary;
  const actual = (await service.getSessionAnalytics(APP)).summary;
  expect(actual).toEqual(expected);
});

test("the summary counts every page view even when the session list scan is bounded", async () => {
  const full = service.buildSessionAnalytics(allRows).summary;
  const bounded = await service.getSessionAnalytics(APP, { scanLimit: 3 });
  expect(bounded.summary.totalPageViews).toBe(10);
  expect(bounded.summary).toEqual(full);
});
