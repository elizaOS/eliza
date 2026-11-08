import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MockSocketRedis } from "../../cache/mock-redis";
import { SocketRedis } from "../../cache/socket-redis";
import type { TaskStoreEntry } from "../a2a-task-store";

const redisUrl = process.env.A2A_REDIS_TEST_URL;
const redisSuite = redisUrl ? describe : describe.skip;
const prefix = `quint-a2a-${randomUUID()}`;
const original = {
  get: SocketRedis.prototype.get,
  set: SocketRedis.prototype.set,
  setex: SocketRedis.prototype.setex,
  del: SocketRedis.prototype.del,
  eval: SocketRedis.prototype.eval,
  zadd: SocketRedis.prototype.zadd,
  zrem: SocketRedis.prototype.zrem,
};
let store: typeof import("../a2a-task-store")["a2aTaskStoreService"];
let control: SocketRedis;
const clients = new Set<SocketRedis>();
const keys = new Set<string>();
const releases = new Set<() => void>();
const savedEnv = {
  REDIS_URL: process.env.REDIS_URL,
  DIRECT_REDIS_BACKEND: process.env.DIRECT_REDIS_BACKEND,
  MOCK_REDIS: process.env.MOCK_REDIS,
  ENVIRONMENT: process.env.ENVIRONMENT,
};
function task() {
  const id = randomUUID();
  const organizationId = randomUUID();
  const timestamp = new Date().toISOString();
  keys.add(`${prefix}:a2a:task:${id}`);
  keys.add(`${prefix}:a2a:task-lock:${id}`);
  keys.add(`a2a:org:${organizationId}`);
  const entry: TaskStoreEntry = {
    task: { id, status: { state: "working", timestamp }, history: [] },
    userId: "quint-fixture",
    organizationId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return { id, organizationId, entry };
}
function append(text: string) {
  return (entry: TaskStoreEntry): TaskStoreEntry => ({
    ...entry,
    task: {
      ...entry.task,
      history: [...(entry.task.history ?? []), { role: "user", parts: [{ type: "text", text }] }],
    },
  });
}
function barrier() {
  const reached = Promise.withResolvers<void>();
  const continued = Promise.withResolvers<void>();
  releases.add(continued.resolve);
  return {
    reached: reached.promise,
    release: continued.resolve,
    pause: async () => {
      reached.resolve();
      await continued.promise;
    },
  };
}
function pauseWrite(id: string) {
  const gate = barrier();
  let first = true;
  SocketRedis.prototype.setex = async function (key, ttl, value) {
    if (first && key === `${prefix}:a2a:task:${id}`) {
      first = false;
      await gate.pause();
    }
    return original.setex.call(this, key, ttl, value);
  };
  SocketRedis.prototype.eval = async function (script, names, args) {
    if (first && script.includes("SETEX") && names[1] === `${prefix}:a2a:task:${id}`) {
      first = false;
      await gate.pause();
    }
    return original.eval.call(this, script, names, args);
  };
  return gate;
}
async function expire(id: string) {
  const key = `${prefix}:a2a:task-lock:${id}`;
  expect(await control.pexpire(key, 0)).toBe(1);
  expect(await control.get<string>(key)).toBeNull();
}

redisSuite("A2A real Redis lease ownership", () => {
  beforeAll(async () => {
    const url = new URL(redisUrl!);
    expect(["redis:", "rediss:"]).toContain(url.protocol);
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(url.hostname);
    process.env.REDIS_URL = redisUrl;
    process.env.DIRECT_REDIS_BACKEND = "redis";
    process.env.MOCK_REDIS = "0";
    process.env.ENVIRONMENT = prefix;
    SocketRedis.prototype.set = function (...args) {
      clients.add(this);
      return original.set.apply(this, args);
    };
    control = new SocketRedis({ url: redisUrl! });
    clients.add(control);
    expect(await control.ping()).toBe("PONG");
    store = (await import("../a2a-task-store")).a2aTaskStoreService;
  });
  afterEach(async () => {
    for (const release of releases) release();
    releases.clear();
    SocketRedis.prototype.get = original.get;
    SocketRedis.prototype.setex = original.setex;
    SocketRedis.prototype.del = original.del;
    SocketRedis.prototype.eval = original.eval;
    SocketRedis.prototype.zadd = original.zadd;
    SocketRedis.prototype.zrem = original.zrem;
    await control.del(...keys);
    keys.clear();
  });
  afterAll(async () => {
    SocketRedis.prototype.set = original.set;
    await Promise.all([...clients].map((client) => client.close()));
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("an expired append cannot overwrite an acknowledged successor", async () => {
    const t = task();
    await store.set(t.id, t.entry);
    const gate = pauseWrite(t.id);
    const old = store.update(t.id, t.organizationId, append("old")).catch((error) => error);
    await gate.reached;
    await expire(t.id);
    await store.update(t.id, t.organizationId, append("new"));
    gate.release();
    expect((await old).code).toBe("A2A_TASK_STORE_WRITE_CONFLICT");
    expect((await store.get(t.id, t.organizationId))?.task.history).toEqual(
      append("new")(t.entry).task.history,
    );
  }, 15000);

  test("an expired set cannot replace a newer task", async () => {
    const t = task();
    const gate = pauseWrite(t.id);
    const old = store.set(t.id, append("old")(t.entry)).catch((error) => error);
    await gate.reached;
    await expire(t.id);
    await store.set(t.id, append("new")(t.entry));
    gate.release();
    expect((await old).code).toBe("A2A_TASK_STORE_WRITE_CONFLICT");
    expect((await store.get(t.id, t.organizationId))?.task.history).toEqual(
      append("new")(t.entry).task.history,
    );
  }, 15000);

  test("release cannot delete a replacement lease", async () => {
    const t = task();
    await store.set(t.id, t.entry);
    const gate = barrier();
    let first = true;
    const lock = `${prefix}:a2a:task-lock:${t.id}`;
    SocketRedis.prototype.get = async function <T = string>(key: string) {
      const result = (await original.get.call(this, key)) as T | null;
      if (first && key === lock) {
        first = false;
        await gate.pause();
      }
      return result;
    };
    SocketRedis.prototype.eval = async function (script, names, args) {
      if (first && script.includes("DEL") && names[0] === lock && names[1] === lock) {
        first = false;
        await gate.pause();
      }
      return original.eval.call(this, script, names, args);
    };
    const writing = store.update(t.id, t.organizationId, append("owned"));
    await gate.reached;
    await expire(t.id);
    expect(await control.set(lock, "successor", { nx: true, px: 5000 })).toBe("OK");
    gate.release();
    await writing;
    expect(await control.get<string>(lock)).toBe("successor");
  }, 15000);

  test("an expired delete cannot remove a recreated task", async () => {
    const t = task();
    await store.set(t.id, t.entry);
    const gate = barrier();
    let first = true;
    const key = `${prefix}:a2a:task:${t.id}`;
    SocketRedis.prototype.del = async function (...names) {
      if (first && names.includes(key)) {
        first = false;
        await gate.pause();
      }
      return original.del.apply(this, names);
    };
    SocketRedis.prototype.eval = async function (script, names, args) {
      if (first && script.includes("DEL") && names[1] === key) {
        first = false;
        await gate.pause();
      }
      return original.eval.call(this, script, names, args);
    };
    const deletion = store.delete(t.id, t.organizationId).catch((error) => error);
    await gate.reached;
    await expire(t.id);
    await store.set(t.id, append("replacement")(t.entry));
    gate.release();
    expect((await deletion).code).toBe("A2A_TASK_STORE_WRITE_CONFLICT");
    expect((await store.get(t.id, t.organizationId))?.task.history).toEqual(
      append("replacement")(t.entry).task.history,
    );
  }, 15000);

  test("overlapping appends retain ordered duplicate and Unicode content", async () => {
    const t = task();
    await store.set(t.id, t.entry);
    const gate = pauseWrite(t.id);
    const first = store.update(t.id, t.organizationId, append("同じ ✨"));
    await gate.reached;
    const second = store.update(t.id, t.organizationId, append("同じ ✨"));
    gate.release();
    await first;
    await second;
    expect((await store.get(t.id, t.organizationId))?.task.history).toEqual(
      append("同じ ✨")(append("同じ ✨")(t.entry)).task.history,
    );
  }, 15000);

  test("foreign update and delete cannot change the task", async () => {
    const t = task();
    await store.set(t.id, t.entry);
    const foreign = randomUUID();
    let called = false;
    expect(
      await store.update(t.id, foreign, (entry) => {
        called = true;
        return entry;
      }),
    ).toBeNull();
    expect(await store.delete(t.id, foreign)).toBe(false);
    expect(called).toBe(false);
    expect(await store.get(t.id, t.organizationId)).toEqual(t.entry);
  });

  test("index failure reports the uncertain write and preserves full task data", async () => {
    const t = task();
    await store.set(t.id, t.entry);
    SocketRedis.prototype.zadd = async () => {
      throw new Error("injected index failure");
    };
    await expect(store.update(t.id, t.organizationId, append("保存済み"))).rejects.toThrow(
      "injected index failure",
    );
    expect((await store.get(t.id, t.organizationId))?.task.history).toEqual(
      append("保存済み")(t.entry).task.history,
    );
  });

  test("delete index failure reports uncertainty and retains a stale member", async () => {
    const t = task();
    await store.set(t.id, t.entry);
    SocketRedis.prototype.zrem = async () => {
      throw new Error("injected removal failure");
    };
    await expect(store.delete(t.id, t.organizationId)).rejects.toThrow("injected removal failure");
    expect(await store.get(t.id, t.organizationId)).toBeNull();
    expect(await control.zrange(`a2a:org:${t.organizationId}`, 0, -1)).toEqual([t.id]);
  });

  test("an old organization index cannot disclose a replacement owner", async () => {
    const t = task();
    const replacement = task();
    await store.set(t.id, t.entry);
    SocketRedis.prototype.zrem = async () => {
      throw new Error("retained legacy index");
    };
    await expect(store.delete(t.id, t.organizationId)).rejects.toThrow("retained legacy index");
    SocketRedis.prototype.zrem = original.zrem;
    await store.set(t.id, {
      ...append("foreign-only")(t.entry),
      organizationId: replacement.organizationId,
    });
    expect(await store.listByOrganization(t.organizationId)).toEqual([]);
    expect((await store.listByOrganization(replacement.organizationId))[0]?.organizationId).toBe(
      replacement.organizationId,
    );
  });

  test("a supplied task ID cannot replace another organization's live task", async () => {
    const t = task();
    const other = task();
    await store.set(t.id, t.entry);
    const outcome = await store
      .set(t.id, { ...t.entry, organizationId: other.organizationId })
      .catch((error) => error);
    expect(outcome?.code).toBe("A2A_TASK_STORE_WRITE_CONFLICT");
    expect(await store.get(t.id, t.organizationId)).toEqual(t.entry);
    expect(await store.get(t.id, other.organizationId)).toBeNull();
  });

  test("explicit memory backend applies the same atomic token comparisons", async () => {
    const memory = new MockSocketRedis();
    const id = randomUUID();
    const lock = `${id}:lock`;
    await memory.set(lock, "old", { nx: true, px: 5000 });
    await memory.pexpire(lock, 0);
    await memory.set(lock, "new", { nx: true, px: 5000 });
    expect(await memory.setexIfLocked(lock, "old", id, 60, "stale")).toBe(false);
    expect(await memory.delIfLocked(lock, "old", lock)).toBe(false);
    expect(await memory.get<string>(lock)).toBe("new");
    expect(await memory.setexIfLocked(lock, "new", id, 60, "current")).toBe(true);
    expect(await memory.get<string>(id)).toBe("current");
    expect(
      await memory.setexIfLocked(
        lock,
        "new",
        id,
        60,
        "foreign",
        (current) => current === "different-owner",
      ),
    ).toBe(false);
    expect(await memory.get<string>(id)).toBe("current");
    expect(await memory.delIfLocked(lock, "new", id)).toBe(true);
    expect(await memory.delIfLocked(lock, "new", lock)).toBe(true);
  });
});
