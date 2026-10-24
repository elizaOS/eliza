import type { DiscordInstallWelcomeRedis } from "../../src/discord-install-welcome-queue";

/**
 * Lists and keys like @upstash/redis over REST: members are stored as sent and
 * handed back JSON-parsed (its default deserialization). `lists` is exposed so
 * tests can assert what is still pending or in flight.
 */
export function upstashLikeRedis(): DiscordInstallWelcomeRedis & {
  lists: Map<string, string[]>;
} {
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
    lists,
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
