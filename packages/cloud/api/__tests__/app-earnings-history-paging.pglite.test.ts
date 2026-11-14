/**
 * GET /api/v1/apps/:id/earnings/history pages a ledger whose rows share one
 * `created_at` (every movement of a settlement is written in one transaction)
 * without repeating or skipping a transaction, and reports `hasMore` from the
 * rows that remain, not from the page size. Real route, PGlite database,
 * caller authenticated as the app's organization.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const APP = "33333333-3333-4333-8333-333333333333";
const SAME_TX_ROWS = 60;
const OLDER = "44444444-4444-4444-8444-444444444444";

const realAuth = { ...(await import("@elizaos/cloud-shared/lib/auth")) };
const owner = {
  id: USER,
  organization_id: ORG,
  organization: { id: ORG, name: "Earnings org", is_active: true },
  is_active: true,
  role: "owner",
};
mock.module("@elizaos/cloud-shared/lib/auth", () => ({
  ...realAuth,
  requireAuthOrApiKeyWithOrg: async () => ({ user: owner, apiKey: undefined }),
}));

const { dbWrite, closeDatabaseConnectionsForTests } = await import(
  "@elizaos/cloud-shared/db/client"
);
const { organizations } = await import(
  "@elizaos/cloud-shared/db/schemas/organizations"
);
const { users } = await import("@elizaos/cloud-shared/db/schemas/users");
const { apps, appDeploymentStatusEnum, appReviewStatusEnum } = await import(
  "@elizaos/cloud-shared/db/schemas/apps"
);
const { appEarningsTransactions } = await import(
  "@elizaos/cloud-shared/db/schemas"
);
const { Hono } = await import("hono");
const { default: historyRoute } = await import(
  "../v1/apps/[id]/earnings/history/route.ts"
);

const app = new Hono();
app.route("/api/v1/apps/:id/earnings/history", historyRoute);
const workerEnv = { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true" };

type Page = {
  transactions: Array<{ id: string }>;
  pagination: { limit: number; offset: number; hasMore: boolean };
};

async function page(limit: number, offset: number): Promise<Page> {
  const response = await app.request(
    `/api/v1/apps/${APP}/earnings/history?limit=${limit}&offset=${offset}`,
    { method: "GET" },
    workerEnv,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Page;
}

beforeAll(async () => {
  const { apply } = await pushSchema(
    {
      appDeploymentStatusEnum,
      appReviewStatusEnum,
      organizations,
      users,
      apps,
      appEarningsTransactions,
    } as never,
    dbWrite as never,
  );
  await apply();
  await dbWrite
    .insert(organizations)
    .values({ id: ORG, name: "Earnings org", slug: "earnings-org" });
  await dbWrite.insert(users).values({
    id: USER,
    organization_id: ORG,
    steward_user_id: "steward",
    email: "o@example.test",
  });
  await dbWrite.insert(apps).values({
    id: APP,
    name: "Earnings app",
    slug: "earnings-app",
    organization_id: ORG,
    created_by_user_id: USER,
    app_url: "https://earnings.example.test",
  });
  const settledAt = new Date("2026-10-13T12:00:00.000Z");
  await dbWrite.insert(appEarningsTransactions).values([
    ...Array.from({ length: SAME_TX_ROWS }, (_, index) => ({
      app_id: APP,
      type: "inference_markup",
      amount: "0.010000",
      metadata: { seq: index },
      created_at: settledAt,
    })),
    {
      id: OLDER,
      app_id: APP,
      type: "withdrawal",
      amount: "-1.000000",
      created_at: new Date("2026-10-12T12:00:00.000Z"),
    },
  ]);
}, 120_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  mock.restore();
});

test("walking the history in pages of 10 shows every transaction exactly once", async () => {
  const seen = new Map<string, number>();
  let offset = 0;
  let last: Page | undefined;
  for (let guard = 0; guard < 20; guard += 1) {
    last = await page(10, offset);
    for (const row of last.transactions)
      seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
    if (!last.pagination.hasMore) break;
    offset += 10;
  }
  expect(last?.pagination.hasMore).toBe(false);
  expect([...seen.values()].every((count) => count === 1)).toBe(true);
  expect(seen.size).toBe(SAME_TX_ROWS + 1);
  expect(last?.transactions.at(-1)?.id).toBe(OLDER);
});

test("hasMore is false when the page holds the last remaining rows", async () => {
  const whole = await page(SAME_TX_ROWS + 1, 0);
  expect(whole.transactions).toHaveLength(SAME_TX_ROWS + 1);
  expect(whole.pagination.hasMore).toBe(false);

  const first = await page(10, 0);
  expect(first.transactions).toHaveLength(10);
  expect(first.pagination.hasMore).toBe(true);
});

test("limit=0 is the documented empty page and reports nothing more", async () => {
  const none = await page(0, 0);
  expect(none.transactions).toEqual([]);
  expect(none.pagination).toEqual({ limit: 0, offset: 0, hasMore: false });
});
