/**
 * A room lock guards one agent turn. The turn (model call plus tools) can
 * outlast the lock TTL, and nothing extended the lock, so a second message
 * for the room started a concurrent turn. With `keepAlive` the lock renews
 * itself until it is released.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

const fixtureEnvironment = { CACHE_ENABLED: "true", CACHE_BACKEND: "memory" };
const previousEnvironment = Object.fromEntries(
  Object.keys(fixtureEnvironment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, fixtureEnvironment);

type LocksModule = typeof import("./distributed-locks");
let locks: LocksModule["distributedLocks"];

beforeAll(async () => {
  ({ distributedLocks: locks } = await import("./distributed-locks"));
});

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("a kept-alive lock outlives its TTL until it is released", async () => {
  const roomId = randomUUID();
  const held = await locks.acquireRoomLock(roomId, 300, { keepAlive: true });
  expect(held).not.toBeNull();

  // Three TTLs later the turn is still running.
  await Bun.sleep(900);
  expect(await locks.acquireRoomLock(roomId, 300)).toBeNull();

  await held?.release();
  const next = await locks.acquireRoomLock(roomId, 300);
  expect(next).not.toBeNull();
  await next?.release();
});

test("a lock without keepAlive still expires on its own", async () => {
  const roomId = randomUUID();
  const held = await locks.acquireRoomLock(roomId, 200);
  expect(held).not.toBeNull();
  await Bun.sleep(300);
  const next = await locks.acquireRoomLock(roomId, 200);
  expect(next).not.toBeNull();
  await next?.release();
});
