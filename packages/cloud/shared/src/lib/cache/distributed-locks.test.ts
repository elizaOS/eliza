/**
 * Room locks need atomic SET NX. On Cloudflare KV setIfNotExists is
 * get-then-put, so two instances could both "acquire" one room; there the
 * service must take its dummy-lock path instead of the racy one.
 */
import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.CACHE_ENABLED = "true";
process.env.CACHE_BACKEND = "memory";

const { cache } = await import("./client");
const { distributedLocks } = await import("./distributed-locks");

const spies: Array<{ mockRestore(): void }> = [];

beforeAll(() => {
  expect(cache.getBackendKind()).toBe("memory");
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("a room lock on a non-atomic backend never uses set-if-not-exists", async () => {
  spies.push(spyOn(cache, "supportsAtomicOperations").mockReturnValue(false));
  const setIfNotExists = spyOn(cache, "setIfNotExists");
  spies.push(setIfNotExists);

  const roomId = randomUUID();
  const first = await distributedLocks.acquireRoomLock(roomId);
  const second = await distributedLocks.acquireRoomLock(roomId);

  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(setIfNotExists).not.toHaveBeenCalled();
  expect(distributedLocks.isEnabled()).toBe(false);
});

test("a room lock on an atomic backend excludes a second holder", async () => {
  const roomId = randomUUID();
  const first = await distributedLocks.acquireRoomLock(roomId);
  expect(first).not.toBeNull();
  expect(await distributedLocks.acquireRoomLock(roomId)).toBeNull();

  await first?.release();
  expect(await distributedLocks.acquireRoomLock(roomId)).not.toBeNull();
});
