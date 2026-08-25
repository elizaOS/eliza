import { describe, expect, it, vi } from "vitest";
import { CacheStore } from "./cache.store";

type DbChain = ReturnType<typeof makeDb>;

function makeDb(
  opts: { rows?: Array<{ value: unknown }>; failGet?: Error; failInsert?: Error } = {}
) {
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            if (opts.failGet) throw opts.failGet;
            return opts.rows ?? [];
          }),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(async () => {
          if (opts.failInsert) throw opts.failInsert;
        }),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => {}),
    })),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        delete: () => ({ where: vi.fn(async () => {}) }),
      })
    ),
  };
  return db;
}

function makeStore(db: DbChain) {
  return new CacheStore({
    agentId: "agent-1",
    getDb: () => db,
    withRetry: (fn: () => Promise<unknown>) => fn(),
  } as never);
}

describe("CacheStore fail-loud boundaries", () => {
  it("returns the cached value on hit", async () => {
    const db = makeDb({ rows: [{ value: "v1" }] });
    await expect(makeStore(db).get<string>("k")).resolves.toBe("v1");
    expect(db.select).toHaveBeenCalledWith({ value: expect.anything() });
  });

  it("returns undefined on cache miss (empty result)", async () => {
    const db = makeDb({ rows: [] });
    await expect(makeStore(db).get<string>("k")).resolves.toBeUndefined();
  });

  it("propagates query failures instead of masking them as a miss", async () => {
    // A broken DB must never read as "not cached": undefined would let the
    // caller refetch and overwrite a possibly-fresh value silently.
    const db = makeDb({
      failGet: new Error("db exploded"),
    });
    await expect(makeStore(db).get<string>("k")).rejects.toThrow("db exploded");
  });

  it("returns true after an upsert on set", async () => {
    const db = makeDb();
    const store = makeStore(db);
    await expect(store.set("k", { n: 1 })).resolves.toBe(true);
    const chain = db.insert.mock.results[0]?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    const values = chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values).toMatchObject({ key: "k", agentId: "agent-1" });
    const upsert = chain.values.mock.results[0]?.value as {
      onConflictDoUpdate: ReturnType<typeof vi.fn>;
    };
    expect(upsert.onConflictDoUpdate).toHaveBeenCalledWith({
      target: [expect.anything(), expect.anything()],
      set: { value: { n: 1 } },
    });
  });

  it("propagates write failures instead of returning a benign false", async () => {
    const db = makeDb({
      failInsert: new Error("disk full"),
    });
    await expect(makeStore(db).set("k", 1)).rejects.toThrow("disk full");
  });

  it("returns true after delete", async () => {
    const db = makeDb();
    await expect(makeStore(db).delete("k")).resolves.toBe(true);
  });
});
