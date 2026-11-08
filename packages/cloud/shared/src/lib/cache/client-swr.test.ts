/**
 * Stale-while-revalidate on a Worker: work left after the response can be
 * cancelled, so a queued revalidation may never settle. Its queue entry must
 * not block that key for the life of the isolate.
 */
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.CACHE_ENABLED = "true";
process.env.CACHE_BACKEND = "memory";

const { CacheClient } = await import("./client");

afterEach(() => {
  setSystemTime();
});

async function seedStale(client: InstanceType<typeof CacheClient>, key: string): Promise<void> {
  const cachedAt = Date.now() - 10_000;
  await client.set(key, { data: "old", cachedAt, staleAt: cachedAt + 1_000 }, 600);
}

test("a revalidation that never settles is evicted after the revalidation timeout", async () => {
  const client = new CacheClient();
  const key = `swr-test:${randomUUID()}`;
  await seedStale(client, key);

  let calls = 0;
  let finishStuck!: (value: string) => void;
  const stuck = () => {
    calls += 1;
    return new Promise<string>((resolve) => {
      finishStuck = resolve;
    });
  };

  expect(await client.getWithSWR(key, 1, stuck)).toBe("old");
  expect(await client.getWithSWR(key, 1, stuck)).toBe("old");
  expect(calls).toBe(1);

  // Past REVALIDATION_TIMEOUT_MS the stuck entry no longer blocks the key.
  setSystemTime(new Date(Date.now() + 31_000));
  const waitUntil: Promise<unknown>[] = [];
  expect(
    await client.getWithSWR(key, 1, async () => "fresh", undefined, {
      waitUntil: (promise) => waitUntil.push(promise),
    }),
  ).toBe("old");
  expect(waitUntil).toHaveLength(1);
  await Promise.all(waitUntil);
  setSystemTime();
  const fresh = await client.get<{ data: string }>(key);
  expect(fresh?.data).toBe("fresh");

  // Settle the stuck call so its timeout timer is cleared.
  finishStuck("late");
});
