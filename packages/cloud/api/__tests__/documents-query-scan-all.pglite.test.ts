/**
 * POST /api/v1/documents/query scores every document in the scope, not only
 * the newest page, and reports `total` as the number of matches. Real route
 * and real document repository over PGlite; authentication and rate limiting
 * are stubbed.
 */
import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
/** One more than the page the route used to read. */
const DOCUMENTS = 201;
const OLDEST_ID = "33333333-3333-4333-8333-000000000000";
const RARE = "zebra-quartz-7731";
const COMMON = "quarterly-forecast";
const COMMON_COUNT = 7;

const realAuth = { ...(await import("@elizaos/cloud-shared/auth")) };
const authedUser = {
  id: USER,
  organization_id: ORG,
  organization: { id: ORG, name: "Documents org", is_active: true },
  is_active: true,
};
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKey: async () => authedUser,
  requireUserOrApiKeyWithOrg: async () => authedUser,
}));
const realRateLimit = {
  ...(await import(
    "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare"
  )),
};
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    ...realRateLimit,
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  }),
);

const { dbWrite, closeDatabaseConnectionsForTests } = await import(
  "@elizaos/cloud-shared/db/client"
);
const { agentTable, entityTable, memoryTable, roomTable } = await import(
  "@elizaos/cloud-shared/db/schemas"
);
const { memoriesRepository } = await import(
  "@elizaos/cloud-shared/db/repositories/agents/memories"
);
const { inArray } = await import("drizzle-orm");
const { Hono } = await import("hono");
const { default: queryRoute } = await import("../v1/documents/query/route");

const app = new Hono();
app.route("/api/v1/documents/query", queryRoute);
const workerEnv = { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true" };

async function query(text: string, limit: number) {
  const response = await app.request(
    "/api/v1/documents/query",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: text, limit }),
    },
    workerEnv,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    results: Array<{ id: string }>;
    total: number;
  };
}

beforeAll(async () => {
  const { apply } = await pushSchema(
    { agentTable, entityTable, roomTable, memoryTable } as never,
    dbWrite as never,
  );
  await apply();
  // Documents are memories of the user's own agent, in the user's own room.
  await dbWrite
    .insert(agentTable)
    .values({ id: USER, name: "Documents agent" });
  await dbWrite.insert(entityTable).values({ id: USER, agentId: USER });
  await dbWrite
    .insert(roomTable)
    .values({ id: USER, agentId: USER, source: "test", type: "DM" });
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  for (let index = 0; index < DOCUMENTS; index += 1) {
    // The oldest document alone carries the rare term; the oldest seven
    // carry the common one. Newest-first paging reaches none of them.
    const text =
      index === 0
        ? `budget memo ${RARE} ${COMMON}`
        : index < COMMON_COUNT
          ? `budget memo ${COMMON} ${index}`
          : `document ${index}`;
    await dbWrite.insert(memoryTable).values({
      id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
      roomId: USER,
      entityId: USER,
      agentId: USER,
      type: "documents",
      content: { text },
      metadata: { filename: `doc-${index}.txt` },
      unique: false,
      createdAt: new Date(start + index * 60_000),
    });
  }
}, 120_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  mock.restore();
});

test("a term that only the oldest document carries is found", async () => {
  const found = await query(RARE, 5);
  expect(found.results.map((result) => result.id)).toEqual([OLDEST_ID]);
  expect(found.total).toBe(1);
});

test("total counts every matching document, not the returned page", async () => {
  const found = await query(COMMON, 5);
  expect(found.results).toHaveLength(5);
  expect(found.total).toBe(COMMON_COUNT);
});

/** Runs `change` once, right after the route has read its first page. */
function afterFirstPage(change: () => Promise<unknown>) {
  const original = memoriesRepository.search.bind(memoriesRepository);
  let pages = 0;
  const spy = spyOn(memoriesRepository, "search").mockImplementation(
    async (options) => {
      const page = await original(options);
      pages += 1;
      if (pages === 1) await change();
      return page;
    },
  );
  return spy;
}

test("a document uploaded between page reads does not repeat a match", async () => {
  const spy = afterFirstPage(() =>
    dbWrite.insert(memoryTable).values({
      id: "44444444-4444-4444-8444-000000000001",
      roomId: USER,
      entityId: USER,
      agentId: USER,
      type: "documents",
      content: { text: "a fresh upload" },
      metadata: { filename: "fresh.txt" },
      unique: false,
      createdAt: new Date("2027-01-01T00:00:00.000Z"),
    }),
  );
  try {
    const found = await query(COMMON, 25);
    const ids = found.results.map((result) => result.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(found.total).toBe(COMMON_COUNT);
  } finally {
    spy.mockRestore();
  }
});

test("a document deleted between page reads does not hide an unread match", async () => {
  // Two documents the first page already read are removed.
  const readIds = [DOCUMENTS - 1, DOCUMENTS - 2].map(
    (index) => `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
  );
  const spy = afterFirstPage(() =>
    dbWrite.delete(memoryTable).where(inArray(memoryTable.id, readIds)),
  );
  try {
    const found = await query(RARE, 5);
    expect(found.results.map((result) => result.id)).toEqual([OLDEST_ID]);
    expect(found.total).toBe(1);
  } finally {
    spy.mockRestore();
  }
});
