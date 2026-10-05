/** Exercises subscription persistence, isolation and cleanup through the real repository and PGlite migration. */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";

const migration = await Bun.file(
  new URL("./migrations/0172_web_push_subscriptions.sql", import.meta.url),
).text();

test("subscriptions survive rotation and migration replay, then respect owner and device cleanup", async () => {
  const { getPgliteClientForTests, closeDatabaseConnectionsForTests } = await import("./client");
  const { webPushSubscriptionsRepository: repository } = await import(
    "./repositories/web-push-subscriptions"
  );
  const database = getPgliteClientForTests();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const endpoint = "https://push.example.test/device-a";
  const otherEndpoint = "https://push.example.test/device-b";
  try {
    await database.exec("CREATE TABLE users (id uuid PRIMARY KEY)");
    await database.query("INSERT INTO users (id) VALUES ($1), ($2)", [userId, otherUserId]);
    await database.exec(migration);
    const input = { userId, agentId, endpoint, p256dh: "original-key", auth: "original-auth" };
    const first = await repository.upsert(input);
    const otherAgent = await repository.upsert({ ...input, agentId: otherAgentId });
    const otherUser = await repository.upsert({
      ...input,
      userId: otherUserId,
      endpoint: otherEndpoint,
    });
    const rotated = await repository.upsert({
      ...input,
      p256dh: "rotated-key",
      auth: "rotated-auth",
    });
    expect(rotated.id).toBe(first.id);
    expect(rotated).toMatchObject({ p256dh: "rotated-key", auth: "rotated-auth" });

    await database.exec(migration);
    expect(await repository.listForUserAgent(userId, agentId)).toEqual([rotated]);
    expect(await repository.listForUserAgent(userId, otherAgentId)).toEqual([otherAgent]);
    expect(await repository.listForUserAgent(otherUserId, agentId)).toEqual([otherUser]);
    expect(await repository.listForUserAgent(otherUserId, otherAgentId)).toEqual([]);
    expect(await repository.deleteByEndpoint(otherUserId, endpoint)).toBe(0);
    expect(await repository.listForUserAgent(userId, agentId)).toEqual([rotated]);
    expect(await repository.pruneEndpoints([])).toBe(0);
    expect(await repository.listForUserAgent(userId, otherAgentId)).toEqual([otherAgent]);

    expect(await repository.pruneEndpoints([endpoint])).toBe(2);
    expect(await repository.listForUserAgent(userId, agentId)).toEqual([]);
    expect(await repository.listForUserAgent(userId, otherAgentId)).toEqual([]);
    expect(await repository.listForUserAgent(otherUserId, agentId)).toEqual([otherUser]);
    await repository.upsert(input);
    await repository.upsert({ ...input, agentId: otherAgentId });
    expect(await repository.deleteByEndpoint(userId, endpoint)).toBe(2);
    expect(await repository.listForUserAgent(userId, agentId)).toEqual([]);
    expect(await repository.listForUserAgent(userId, otherAgentId)).toEqual([]);
    expect(await repository.listForUserAgent(otherUserId, agentId)).toEqual([otherUser]);
    await database.query("DELETE FROM users WHERE id = $1", [otherUserId]);
    expect(await repository.listForUserAgent(otherUserId, agentId)).toEqual([]);
  } finally {
    await closeDatabaseConnectionsForTests();
  }
}, 60_000);
