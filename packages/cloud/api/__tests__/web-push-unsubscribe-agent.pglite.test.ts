/**
 * DELETE /api/v1/web-push/subscriptions with an agentId removes only that
 * agent's subscription for the device; without it every agent's row for the
 * endpoint goes. Real repository on PGlite (subscription migration applied),
 * real Hono route; authentication is stubbed.
 */
import { afterAll, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const USER = randomUUID();
const AGENT_A = randomUUID();
const AGENT_B = randomUUID();
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/device-a";

const realAuth = { ...(await import("@elizaos/cloud-shared/auth")) };
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: async () => ({
    id: USER,
    organization_id: randomUUID(),
    is_active: true,
  }),
}));

const { getPgliteClientForTests, closeDatabaseConnectionsForTests } =
  await import("@elizaos/cloud-shared/db/client");
const { webPushSubscriptionsRepository: repository } = await import(
  "@elizaos/cloud-shared/db/repositories/web-push-subscriptions"
);
const { Hono } = await import("hono");
const { default: route } = await import("../v1/web-push/subscriptions/route");

const app = new Hono();
app.route("/api/v1/web-push/subscriptions", route);

const migration = await Bun.file(
  new URL(
    "../../shared/src/db/migrations/0172_web_push_subscriptions.sql",
    import.meta.url,
  ),
).text();

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  mock.restore();
});

async function unsubscribe(body: Record<string, string>): Promise<Response> {
  return app.request("/api/v1/web-push/subscriptions", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("unsubscribing one agent keeps the device subscribed to the others", async () => {
  const database = getPgliteClientForTests();
  await database.exec("CREATE TABLE users (id uuid PRIMARY KEY)");
  await database.query("INSERT INTO users (id) VALUES ($1)", [USER]);
  await database.exec(migration);
  const input = { userId: USER, endpoint: ENDPOINT, p256dh: "k", auth: "a" };
  await repository.upsert({ ...input, agentId: AGENT_A });
  await repository.upsert({ ...input, agentId: AGENT_B });

  const one = await unsubscribe({ endpoint: ENDPOINT, agentId: AGENT_A });
  expect(one.status).toBe(200);
  expect((await one.json()) as { ok: boolean; removed: number }).toEqual({
    ok: true,
    removed: 1,
  });
  expect(await repository.listForUserAgent(USER, AGENT_A)).toEqual([]);
  expect(await repository.listForUserAgent(USER, AGENT_B)).toHaveLength(1);

  await repository.upsert({ ...input, agentId: AGENT_A });
  const all = await unsubscribe({ endpoint: ENDPOINT });
  expect((await all.json()) as { ok: boolean; removed: number }).toEqual({
    ok: true,
    removed: 2,
  });
  expect(await repository.listForUserAgent(USER, AGENT_B)).toEqual([]);

  const invalid = await unsubscribe({ endpoint: ENDPOINT, agentId: "agent" });
  expect(invalid.status).toBe(400);
}, 60_000);
