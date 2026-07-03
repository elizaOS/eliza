import { afterEach, describe, expect, it } from "vitest";
import { closePgliteSingleton, getPgliteSingletonCache } from "../../index.node";
import { pgliteManagerCacheKey } from "../../pglite/manager-cache";

/**
 * closePgliteSingleton() / getPgliteSingletonCache() are the public accessors
 * that let hosts recover or pre-seed the process-global PGlite manager without
 * hand-copying the private `Symbol.for("elizaos.plugin-sql.global-singletons")`.
 */
describe("closePgliteSingleton", () => {
  afterEach(() => {
    const cache = getPgliteSingletonCache() as ReturnType<typeof getPgliteSingletonCache> & {
      activePgliteManagerKey?: string;
      pgLiteClientManagers?: Map<string, unknown>;
    };
    delete cache.pgLiteClientManager;
    delete cache.activePgliteManagerKey;
    cache.pgLiteClientManagers?.clear();
  });

  it("returns closed:false when no manager is present", async () => {
    delete getPgliteSingletonCache().pgLiteClientManager;

    const result = await closePgliteSingleton();

    expect(result).toEqual({ closed: false, timedOut: false, error: null });
  });

  it("closes and removes the active manager", async () => {
    const cache = getPgliteSingletonCache();
    let closed = false;
    cache.pgLiteClientManager = {
      isShuttingDown: () => false,
      close: async () => {
        closed = true;
      },
    };

    const result = await closePgliteSingleton();

    expect(closed).toBe(true);
    expect(result.closed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.error).toBeNull();
    expect(cache.pgLiteClientManager).toBeUndefined();
  });

  it("removes the active keyed manager from the per-agent cache", async () => {
    const cache = getPgliteSingletonCache() as ReturnType<typeof getPgliteSingletonCache> & {
      activePgliteManagerKey?: string;
      pgLiteClientManagers?: Map<string, unknown>;
    };
    const manager = {
      isShuttingDown: () => false,
      close: async () => {},
    };
    const key = pgliteManagerCacheKey("/tmp/.elizadb", "agent-a");
    cache.pgLiteClientManagers = new Map([[key, manager]]);
    cache.pgLiteClientManager = manager;
    cache.activePgliteManagerKey = key;

    const result = await closePgliteSingleton();

    expect(result.closed).toBe(true);
    expect(cache.pgLiteClientManager).toBeUndefined();
    expect(cache.activePgliteManagerKey).toBeUndefined();
    expect(cache.pgLiteClientManagers.has(key)).toBe(false);
  });

  it("captures a close() error but still drops the manager", async () => {
    const cache = getPgliteSingletonCache();
    const boom = new Error("close failed");
    cache.pgLiteClientManager = {
      isShuttingDown: () => false,
      close: async () => {
        throw boom;
      },
    };

    const result = await closePgliteSingleton();

    expect(result.closed).toBe(true);
    expect(result.error).toBe(boom);
    expect(cache.pgLiteClientManager).toBeUndefined();
  });

  it("reports timedOut when close() exceeds the timeout, then drops it", async () => {
    const cache = getPgliteSingletonCache();
    let release: (() => void) | undefined;
    cache.pgLiteClientManager = {
      isShuttingDown: () => false,
      close: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    };

    const result = await closePgliteSingleton({ timeoutMs: 5 });

    expect(result.timedOut).toBe(true);
    expect(result.closed).toBe(true);
    expect(cache.pgLiteClientManager).toBeUndefined();

    release?.();
  });
});

describe("getPgliteSingletonCache", () => {
  it("returns a stable reference to the same process-global cache", () => {
    expect(getPgliteSingletonCache()).toBe(getPgliteSingletonCache());
  });
});
