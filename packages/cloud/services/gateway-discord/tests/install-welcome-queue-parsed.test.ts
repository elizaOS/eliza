import { describe, expect, it } from "bun:test";
import {
  DiscordInstallWelcomeQueue,
  type DiscordInstallWelcomeRedis,
} from "../src/discord-install-welcome-queue";

// Lists and keys like @upstash/redis over REST: members are stored as sent and
// handed back JSON-parsed (its default deserialization).
function upstashLikeRedis(): DiscordInstallWelcomeRedis {
  const lists = new Map<string, string[]>();
  const keys = new Map<string, unknown>();
  const list = (key: string) => {
    const existing = lists.get(key) ?? [];
    lists.set(key, existing);
    return existing;
  };
  const parsed = (value: string) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  };
  return {
    async get(key) {
      return (keys.get(key) ?? null) as never;
    },
    async set(key, value) {
      keys.set(key, value);
      return "OK";
    },
    async lpush(key, ...values) {
      list(key).unshift(...values.reverse());
      return list(key).length;
    },
    async lmove(source, destination, whereFrom, whereTo) {
      const from = list(source);
      const value = whereFrom === "right" ? from.pop() : from.shift();
      if (value === undefined) return null;
      if (whereTo === "left") list(destination).unshift(value);
      else list(destination).push(value);
      return parsed(value);
    },
    async lrem(key, _count, value) {
      const items = list(key);
      const index = items.indexOf(value);
      if (index < 0) return 0;
      items.splice(index, 1);
      return 1;
    },
  };
}

describe("Discord install welcome queue on a deserializing Redis client", () => {
  it("sends the welcome for a job the client returns already parsed", async () => {
    const sent: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/users/@me/channels"))
        return Response.json({ id: "dm-1" });
      sent.push(JSON.parse(String(init?.body)).content);
      return Response.json({ id: "message-1" });
    }) as typeof fetch;
    const queue = new DiscordInstallWelcomeQueue(
      upstashLikeRedis(),
      "token",
      fetchImpl,
    );
    await queue.enqueue({
      id: "install-1",
      eventTimestamp: "2026-10-10T10:00:00.000Z",
      user: { id: "42", globalName: "Zoë ﬁnch" },
    });

    expect(await queue.drainOnce()).toBe(true);
    expect(sent).toEqual([
      "Hey Zoë ﬁnch — Eliza here. You're connected. Send me a message here and I'll reply.",
    ]);
    expect(await queue.drainOnce()).toBe(false);
  });
});
