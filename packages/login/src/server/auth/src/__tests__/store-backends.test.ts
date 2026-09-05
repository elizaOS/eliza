import { describe, expect, it, spyOn } from "bun:test";

import {
  buildBackend,
  MemoryBackend,
  NamespacedStoreBackend,
  PostgresBackend,
  RedisBackend,
  type RedisLike,
  type StoreBackend,
} from "../store-backends";

function redisLike(overrides: Partial<RedisLike> = {}): RedisLike {
  const store = new Map<string, string>();
  return {
    set: async (key, value) => {
      store.set(key, value);
      return "OK";
    },
    get: async (key) => store.get(key) ?? null,
    getdel: async (key) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    },
    del: async (...keys) => {
      let removed = 0;
      for (const key of keys) if (store.delete(key)) removed += 1;
      return removed;
    },
    eval: async (_script, keys, key, ...args) => {
      const all = [key, ...args].map(String);
      if (keys === 1 && all.length === 2) {
        const [compareKey, expected] = all;
        if (store.get(compareKey) !== expected) return 0;
        store.delete(compareKey);
        return 1;
      }
      if (all.length === keys * 6) {
        const publishKeys = all.slice(0, keys);
        const publishArgs = all.slice(keys);
        const states = publishKeys.flatMap((publishKey, index) => {
          const offset = index * 5;
          const operation = publishArgs[offset];
          const desiredValue = publishArgs[offset + 1];
          const guardKind = publishArgs[offset + 3];
          const expectedValue = publishArgs[offset + 4];
          if (guardKind === "0") return [];
          const current = store.get(publishKey);
          return [
            {
              expected:
                guardKind === "1"
                  ? current === undefined
                  : current === expectedValue,
              desired:
                operation === "D"
                  ? current === undefined
                  : current === desiredValue,
            },
          ];
        });
        if (states.length > 0 && states.every((state) => state.desired))
          return 1;
        if (states.some((state) => !state.expected)) return 0;
        for (let index = 0; index < publishKeys.length; index += 1) {
          const offset = index * 5;
          if (publishArgs[offset] === "D") store.delete(publishKeys[index]);
          else store.set(publishKeys[index], publishArgs[offset + 1]);
        }
        return 1;
      }
      const [guardKey, expected, desired, _ttl, guardExpected] =
        keys === 2 ? args : [undefined, ...args];
      if (
        guardKey !== undefined &&
        store.get(String(guardKey)) !== guardExpected
      )
        return 0;
      const current = store.get(String(key));
      if (current !== expected && current !== desired) return 0;
      store.set(String(key), String(desired));
      return 1;
    },
    ...overrides,
  };
}

describe("buildBackend Redis smoke test", () => {
  it("accepts a Redis client that supports GETDEL", async () => {
    const { source } = await buildBackend("challenge", redisLike(), false);
    expect(source).toBe("redis");
  });

  it("falls back when the Redis client lacks GETDEL (Redis < 6.2)", async () => {
    const client = redisLike({ getdel: undefined });
    const { source } = await buildBackend("challenge", client, false);
    expect(source).toBe("memory");
  });

  it("falls back when the Redis client throws", async () => {
    const client = redisLike({
      set: async () => {
        throw new Error("connection refused");
      },
    });
    const { source } = await buildBackend("challenge", client, false);
    expect(source).toBe("memory");
  });
});

describe("PostgresBackend initialization", () => {
  it("uses a pre-migrated auth store without attempting application-role DDL", async () => {
    const statements: string[] = [];
    let transactionCalls = 0;
    const client = (async (strings: TemplateStringsArray) => {
      const statement = strings.join("?");
      statements.push(statement);
      if (statement.includes("to_regclass"))
        return [{ relation: "auth_kv_store" }];
      return [];
    }) as unknown as ReturnType<
      typeof import("../../../db/src/index.ts").getSql
    >;
    client.begin = async () => {
      transactionCalls += 1;
      throw new Error("application role must not run DDL");
    };

    const backend = new PostgresBackend("challenge", client);
    await backend.set("probe", "value", 1_000);

    expect(transactionCalls).toBe(0);
    expect(
      statements.some((statement) => statement.includes("to_regclass")),
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.includes("INSERT INTO auth_kv_store"),
      ),
    ).toBe(true);
    expect(
      statements.some((statement) => statement.includes("CREATE TABLE")),
    ).toBe(false);
  });
});

describe("NamespacedStoreBackend", () => {
  it("keeps the exact absolute publication deadline in memory", async () => {
    const backend = new MemoryBackend();
    const expiresAt = Date.now() + 30;
    expect(
      await backend.publish([
        { key: "credential", value: "active", expiresAt },
      ]),
    ).toBe(true);
    await Bun.sleep(40);
    expect(await backend.get("credential")).toBeNull();
    backend.destroy();
  });

  it("rejects an expired memory publication before deleting prior credentials", async () => {
    const backend = new MemoryBackend();
    await backend.set("generation", "reservation", 60_000);
    await backend.set("prior-credential", "still-active", 60_000);
    const expired = Date.now() - 1;

    expect(
      await backend.publish([
        { key: "prior-credential", value: null, expiresAt: expired },
        { key: "replacement", value: "already-expired", expiresAt: expired },
        {
          key: "generation",
          value: "published",
          expiresAt: expired,
          expected: "reservation",
        },
      ]),
    ).toBe(false);
    expect(await backend.get("prior-credential")).toBe("still-active");
    expect(await backend.get("replacement")).toBeNull();
    expect(await backend.get("generation")).toBe("reservation");
    backend.destroy();
  });

  it("treats an existing memory guard as expired at its exact deadline", async () => {
    const now = spyOn(Date, "now").mockReturnValue(1_000);
    const backend = new MemoryBackend();
    try {
      await backend.set("guard", "reserved", 1_000);
      now.mockReturnValue(2_000);
      expect(
        await backend.publish([
          {
            key: "guard",
            value: "published",
            expiresAt: 3_000,
            expected: "reserved",
          },
          { key: "credential", value: "active", expiresAt: 3_000 },
        ]),
      ).toBe(false);
      expect(await backend.get("guard")).toBeNull();
      expect(await backend.get("credential")).toBeNull();
    } finally {
      backend.destroy();
      now.mockRestore();
    }
  });

  it("replaces a memory set-if-absent entry at its exact deadline", async () => {
    const now = spyOn(Date, "now").mockReturnValue(1_000);
    const backend = new MemoryBackend();
    try {
      expect(await backend.setIfNotExists("reservation", "old", 1_000)).toBe(
        true,
      );
      now.mockReturnValue(2_000);
      expect(
        await backend.setIfNotExists("reservation", "replacement", 1_000),
      ).toBe(true);
      expect(await backend.get("reservation")).toBe("replacement");
    } finally {
      backend.destroy();
      now.mockRestore();
    }
  });

  it("passes absolute deadlines to an atomic Redis server-time publication", async () => {
    let observedScript = "";
    let observedArgs: Array<string | number> = [];
    const backend = new RedisBackend(
      redisLike({
        eval: async (script, _numberOfKeys, ...args) => {
          observedScript = script;
          observedArgs = args;
          return -1;
        },
      }),
      "test:",
    );
    const expiresAt = Date.now() + 60_000;
    expect(
      await backend.publish([
        { key: "credential", value: "active", expiresAt },
      ]),
    ).toBe(false);
    expect(observedScript).toContain("redis.call('TIME')");
    expect(observedScript).toContain("if ttl<=0 then return -1 end");
    expect(observedArgs).toContain(expiresAt);
  });

  it("rejects duplicate publish keys without applying either value", async () => {
    for (const backend of [
      new MemoryBackend(),
      new RedisBackend(redisLike(), "test:"),
    ]) {
      await expect(
        backend.publish([
          { key: "credential", value: "first", expiresAt: Date.now() + 60_000 },
          {
            key: "credential",
            value: "second",
            expiresAt: Date.now() + 60_000,
          },
        ]),
      ).rejects.toThrow("Store publication contains duplicate keys");
      expect(await backend.get("credential")).toBeNull();
      if (backend instanceof MemoryBackend) backend.destroy();
    }
  });

  it("conditionally publishes all keys or none and makes retries no-ops", async () => {
    for (const backend of [
      new MemoryBackend(),
      new RedisBackend(redisLike(), "test:"),
    ]) {
      await backend.set("generation", "reservation-a", 60_000);

      const entries = [
        {
          key: "generation",
          value: "published-a",
          expiresAt: Date.now() + 60_000,
          expected: "reservation-a",
        },
        { key: "credential", value: "active", expiresAt: Date.now() + 60_000 },
        {
          key: "prior-credential",
          value: null,
          expiresAt: Date.now() + 60_000,
        },
      ] as const;
      expect(await backend.publish(entries)).toBe(true);
      expect(await backend.consume("credential")).toBe("active");
      // A lost-ack retry must be a no-op. Reapplying the unconditional entries
      // here would recreate a credential that was already consumed.
      expect(await backend.publish(entries)).toBe(true);
      expect(await backend.get("credential")).toBeNull();

      await backend.set("generation", "reservation-newer", 60_000);
      expect(
        await backend.publish([
          ...entries,
          {
            key: "should-not-publish",
            value: "unsafe",
            expiresAt: Date.now() + 60_000,
          },
        ]),
      ).toBe(false);
      expect(await backend.get("generation")).toBe("reservation-newer");
      expect(await backend.get("should-not-publish")).toBeNull();
      if (backend instanceof MemoryBackend) backend.destroy();
    }
  });

  it("applies staged transitions atomically and idempotently across reconstructed stores", async () => {
    const backend = new MemoryBackend();
    const first = new NamespacedStoreBackend(backend, "email");
    const second = new NamespacedStoreBackend(backend, "email");
    await first.set("challenge", "staged", 60_000);
    expect(
      await second.transition("challenge", "staged", "active", 60_000),
    ).toBe(true);
    expect(
      await first.transition("challenge", "staged", "active", 60_000),
    ).toBe(true);
    expect(await first.transition("challenge", "staged", "other", 60_000)).toBe(
      false,
    );
    expect(await second.get("challenge")).toBe("active");
    backend.destroy();
  });

  it("uses an idempotent atomic Redis transition", async () => {
    const store = new RedisBackend(redisLike(), "test:");
    await store.set("challenge", "staged", 60_000);
    expect(
      await store.transition("challenge", "staged", "active", 60_000),
    ).toBe(true);
    expect(
      await store.transition("challenge", "staged", "active", 60_000),
    ).toBe(true);
    expect(await store.transition("challenge", "staged", "other", 60_000)).toBe(
      false,
    );
  });

  it("binds transitions to an exact live guard in memory and Redis", async () => {
    for (const store of [
      new MemoryBackend(),
      new RedisBackend(redisLike(), "test:"),
    ]) {
      await store.set("challenge", "staged", 60_000);
      await store.set("target", "newest", 60_000);
      expect(
        await store.transition("challenge", "staged", "active", 60_000, {
          key: "target",
          expected: "superseded",
        }),
      ).toBe(false);
      expect(await store.get("challenge")).toBe("staged");
      expect(
        await store.transition("challenge", "staged", "active", 60_000, {
          key: "target",
          expected: "newest",
        }),
      ).toBe(true);
      expect(await store.get("challenge")).toBe("active");
      if (store instanceof MemoryBackend) store.destroy();
    }
  });

  it("shares values across reconstructed stores in the same namespace", async () => {
    const backend = new MemoryBackend();
    const first = new NamespacedStoreBackend(backend, "wallet-link");
    const reconstructed = new NamespacedStoreBackend(backend, "wallet-link");

    await first.set("challenge", "signed-value", 60_000);

    expect(await reconstructed.get("challenge")).toBe("signed-value");
    backend.destroy();
  });

  it("compare-deletes only an exact live generation and returns false on absence", async () => {
    for (const backend of [
      new MemoryBackend(),
      new RedisBackend(redisLike(), "test:"),
    ]) {
      const store = new NamespacedStoreBackend(backend, "operation-lock");
      await store.set("phone", "owner-a", 60_000);

      expect(await store.compareDelete("phone", "owner-b")).toBe(false);
      expect(await store.get("phone")).toBe("owner-a");
      expect(await store.compareDelete("phone", "owner-a")).toBe(true);
      expect(await store.compareDelete("phone", "owner-a")).toBe(false);

      await store.set("phone", "owner-new", 60_000);
      expect(await store.compareDelete("phone", "owner-a")).toBe(false);
      expect(await store.get("phone")).toBe("owner-new");
      if (backend instanceof MemoryBackend) backend.destroy();
    }
  });

  it("isolates identical keys even when namespace boundaries are ambiguous", async () => {
    const backend = new MemoryBackend();
    const first = new NamespacedStoreBackend(backend, "wallet");
    const second = new NamespacedStoreBackend(backend, "wallet:link");

    await first.set("link:challenge", "first", 60_000);
    await second.set("challenge", "second", 60_000);

    expect(await first.get("link:challenge")).toBe("first");
    expect(await second.get("challenge")).toBe("second");
    backend.destroy();
  });

  it("preserves atomic replay rejection across reconstructed stores", async () => {
    const backend = new MemoryBackend();
    const first = new NamespacedStoreBackend(backend, "oauth-link");
    const reconstructed = new NamespacedStoreBackend(backend, "oauth-link");
    await first.set("state", "proof", 60_000);

    const results = await Promise.all([
      first.consume("state"),
      reconstructed.consume("state"),
    ]);

    expect(results.filter((value) => value === "proof")).toHaveLength(1);
    expect(results.filter((value) => value === null)).toHaveLength(1);
    backend.destroy();
  });

  it("forwards the exact TTL and collision-safe key to the shared backend", async () => {
    const writes: Array<{ key: string; value: string; ttlMs: number }> = [];
    const backend: StoreBackend = {
      set: async (key, value, ttlMs) => {
        writes.push({ key, value, ttlMs });
      },
      setIfNotExists: async () => true,
      get: async () => null,
      consume: async () => null,
      compareDelete: async () => false,
      transition: async () => false,
      publish: async () => true,
      delete: async () => undefined,
    };
    const store = new NamespacedStoreBackend(backend, "oauth-link");

    await store.set("state", "bound-proof", 123_456);

    expect(writes).toEqual([
      { key: "10:oauth-link:state", value: "bound-proof", ttlMs: 123_456 },
    ]);
  });

  it("propagates backend consume failures without replaying or falling back", async () => {
    let consumeCalls = 0;
    const backend: StoreBackend = {
      set: async () => undefined,
      setIfNotExists: async () => true,
      get: async () => null,
      consume: async () => {
        consumeCalls += 1;
        throw new Error("durable backend unavailable");
      },
      compareDelete: async () => false,
      transition: async () => false,
      publish: async () => true,
      delete: async () => undefined,
    };
    const store = new NamespacedStoreBackend(backend, "wallet-link");

    await expect(store.consume("challenge")).rejects.toThrow(
      "durable backend unavailable",
    );
    expect(consumeCalls).toBe(1);
  });
});
