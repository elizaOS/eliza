import { afterAll, describe, expect, test } from "bun:test";
import { SocketRedis } from "../cache/socket-redis";
import { RedisVoiceUsageStore } from "./voice-usage-meter";

const redisUrl = process.env.REDIS_INTEGRATION_URL;
const run = typeof redisUrl === "string" && redisUrl.length > 0;
const suite = run ? describe : describe.skip;
const nonce = `integration-${process.pid}-${Date.now()}`;
const clients = run ? [new SocketRedis(redisUrl), new SocketRedis(redisUrl)] : [];

function identity(suffix: string, user = "user") {
  return { organizationId: `${nonce}-${suffix}`, userId: user };
}

function key(day: string, organizationId: string, userId?: string): string {
  return userId
    ? `voice-usage:${day}:user:${organizationId}:${userId}`
    : `voice-usage:${day}:org:${organizationId}`;
}

afterAll(async () => {
  await Promise.all(clients.map((client) => client.quit()));
});

suite("RedisVoiceUsageStore with real Redis", () => {
  test("shares atomic admission across clients and isolates organizations and users", async () => {
    const now = Date.UTC(2026, 6, 10, 12);
    const stores = clients.map((client) => new RedisVoiceUsageStore(client, () => now));
    const shared = identity("atomic");
    const tightLimits = { organizationDailyMinutes: 1, userDailyMinutes: 1 };

    const decisions = await Promise.all([
      stores[0].checkAndRecord(shared, 1, tightLimits),
      stores[1].checkAndRecord(shared, 1, tightLimits),
    ]);
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(1);

    const orgAUser1 = identity("isolation", "user-1");
    const orgAUser2 = identity("isolation", "user-2");
    const orgBUser1 = identity("other-org", "user-1");
    const limits = { organizationDailyMinutes: 10, userDailyMinutes: 2 };
    expect((await stores[0].checkAndRecord(orgAUser1, 2, limits)).allowed).toBe(true);
    expect(await stores[1].checkAndRecord(orgAUser1, 1, limits)).toMatchObject({
      allowed: false,
      scope: "user",
    });
    expect((await stores[1].checkAndRecord(orgAUser2, 2, limits)).allowed).toBe(true);
    expect((await stores[1].checkAndRecord(orgBUser1, 2, limits)).allowed).toBe(true);
  });

  test("releases reservations, applies TTL, and rolls over at UTC midnight", async () => {
    let now = Date.UTC(2026, 6, 10, 23, 59, 59);
    const store = new RedisVoiceUsageStore(clients[0], () => now);
    const subject = identity("lifecycle");
    const limits = { organizationDailyMinutes: 2, userDailyMinutes: 2 };

    expect((await store.checkAndRecord(subject, 2, limits)).allowed).toBe(true);
    await store.release(subject, 1);
    expect((await store.checkAndRecord(subject, 1, limits)).allowed).toBe(true);

    const ttl = await clients[1].pttl(key("2026-07-10", subject.organizationId));
    expect(ttl).not.toBeNull();
    expect(ttl as number).toBeGreaterThan(86_400_000);
    expect(ttl as number).toBeLessThanOrEqual(86_402_000);

    now = Date.UTC(2026, 6, 11);
    expect(await store.checkAndRecord(subject, 2, limits)).toMatchObject({
      allowed: true,
      day: "2026-07-11",
    });

    await clients[0].del(
      key("2026-07-10", subject.organizationId),
      key("2026-07-10", subject.organizationId, subject.userId),
      key("2026-07-11", subject.organizationId),
      key("2026-07-11", subject.organizationId, subject.userId),
    );
  });
});
