/**
 * Covers the push-token registry: register/list/count/unregister, idempotent
 * upsert, moving a token between platforms, whitespace trimming and empty-token
 * rejection, platform filtering, cache-backed persistence with rehydration,
 * dropping malformed records on hydrate, concurrent first-use hydration, and
 * serialized persistence.
 *
 * Adversarial persistence-boundary coverage: UTF-8 byte-length bounding (not
 * char length), malformed-timestamp rejection (NaN/Infinity/negative/fractional
 * /unsafe-integer/non-number), dedup-before-cap so duplicate-heavy dumps do not
 * underfill, the persisted-record ceiling (exact boundary hydrates, one above
 * fails closed without destroying the durable row), one-time durable repair
 * that never rewrites a clean load, failed-write rollback (in-memory and durable
 * state unchanged, typed error, token redacted), mutation-queue recovery after a
 * failed op, observable atomicity (list/count never see an uncommitted mutation
 * while its write is pending and stay unchanged on rejection), and
 * persistence-boundary validation of direct callers (unsupported platform and
 * non-string token become the typed invalid error). Backed by a Map-backed mock
 * runtime cache — no real storage.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PERSISTED_PUSH_TOKENS,
  MAX_PUSH_TOKEN_BYTES,
  MAX_PUSH_TOKENS_PER_AGENT,
  PUSH_TOKEN_INVALID_CODE,
  PUSH_TOKEN_PERSIST_FAILED_CODE,
  type PushTokenRecord,
  PushTokenRegistry,
} from "./push-token-registry.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa";
const KEY = `push-tokens:${AGENT_ID}`;

function createRuntime(): {
  runtime: IAgentRuntime;
  cache: Map<string, unknown>;
} {
  const cache = new Map<string, unknown>();
  const runtime = createMockRuntime({
    agentId: "00000000-0000-0000-0000-0000000000aa",
    getCache: async <T>(key: string): Promise<T | undefined> =>
      cache.get(key) as T | undefined,
    setCache: async <T>(key: string, value: T): Promise<boolean> => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string): Promise<boolean> => cache.delete(key),
  });
  return { runtime, cache };
}

describe("PushTokenRegistry", () => {
  let ctx: ReturnType<typeof createRuntime>;
  let registry: PushTokenRegistry;

  beforeEach(() => {
    ctx = createRuntime();
    registry = new PushTokenRegistry(ctx.runtime);
  });

  it("registers, lists, and counts a token", async () => {
    await registry.register("ios", "device-token-1");
    const list = await registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ token: "device-token-1", platform: "ios" });
    expect(list[0].createdAt).toBeGreaterThan(0);
    expect(await registry.count()).toBe(1);
  });

  it("upserts the same token idempotently (no duplicate)", async () => {
    await registry.register("android", "tok-a");
    await registry.register("android", "tok-a");
    expect(await registry.count()).toBe(1);
  });

  it("moves a token to a new platform on re-registration", async () => {
    await registry.register("ios", "tok-b");
    await registry.register("android", "tok-b");
    const list = await registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].platform).toBe("android");
  });

  it("trims whitespace and rejects an empty token", async () => {
    await registry.register("ios", "  spaced  ");
    const list = await registry.list();
    expect(list[0].token).toBe("spaced");
    await expect(registry.register("ios", "   ")).rejects.toThrow(/token/);
  });

  it("unregisters and reports existence", async () => {
    await registry.register("ios", "tok-c");
    expect(await registry.unregister("tok-c")).toBe(true);
    expect(await registry.unregister("tok-c")).toBe(false);
    expect(await registry.count()).toBe(0);
  });

  it("filters by platform", async () => {
    await registry.register("ios", "i1");
    await registry.register("ios", "i2");
    await registry.register("android", "a1");
    expect(await registry.listByPlatform("ios")).toHaveLength(2);
    expect(await registry.listByPlatform("android")).toHaveLength(1);
  });

  it("persists to the runtime cache and rehydrates a fresh registry", async () => {
    await registry.register("ios", "persisted-token");
    const restarted = new PushTokenRegistry(ctx.runtime);
    const list = await restarted.list();
    expect(list).toHaveLength(1);
    expect(list[0].token).toBe("persisted-token");
  });

  it("drops malformed records on hydrate", async () => {
    ctx.cache.set("push-tokens:00000000-0000-0000-0000-0000000000aa", [
      { token: "good", platform: "ios", createdAt: 1 },
      { token: "", platform: "ios", createdAt: 2 },
      { token: "bad-platform", platform: "web", createdAt: 3 },
      { nope: true },
    ]);
    const fresh = new PushTokenRegistry(ctx.runtime);
    const list = await fresh.list();
    expect(list.map((r) => r.token)).toEqual(["good"]);
  });

  it("preserves registrations made while first-use hydration is in flight", async () => {
    const cache = new Map<string, unknown>();
    const cacheReads: Array<(value: unknown) => void> = [];
    const runtime = createMockRuntime({
      agentId: "00000000-0000-0000-0000-0000000000aa",
      getCache: <T>(): Promise<T | undefined> =>
        new Promise((resolve) => {
          cacheReads.push(resolve as (value: unknown) => void);
        }),
      setCache: async <T>(key: string, value: T): Promise<boolean> => {
        cache.set(key, value);
        return true;
      },
    });
    const concurrentRegistry = new PushTokenRegistry(runtime);

    const first = concurrentRegistry.register("ios", "ios-token");
    const second = concurrentRegistry.register("android", "android-token");
    await Promise.resolve();
    expect(cacheReads).toHaveLength(1);

    cacheReads[0]([]);
    await first;
    await second;

    expect(
      (await concurrentRegistry.list()).map((record) => record.token).sort(),
    ).toEqual(["android-token", "ios-token"]);
  });

  it("serializes concurrent mutations so persisted tokens cannot regress", async () => {
    let persisted: PushTokenRecord[] = [];
    const pendingWrites: Array<() => void> = [];
    const snapshots: PushTokenRecord[][] = [];
    let firstWriteStarted!: () => void;
    let secondWriteStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstWriteStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      secondWriteStarted = resolve;
    });
    const runtime = createMockRuntime({
      agentId: "00000000-0000-0000-0000-0000000000aa",
      getCache: async <T>(): Promise<T | undefined> => persisted as T,
      setCache: <T>(_key: string, value: T): Promise<boolean> => {
        const snapshot = value as PushTokenRecord[];
        snapshots.push(snapshot);
        (snapshots.length === 1 ? firstWriteStarted : secondWriteStarted)();
        return new Promise((resolve) => {
          pendingWrites.push(() => {
            persisted = snapshot;
            resolve(true);
          });
        });
      },
    });
    const concurrentRegistry = new PushTokenRegistry(runtime);

    const first = concurrentRegistry.register("ios", "ios-token");
    const second = concurrentRegistry.register("android", "android-token");
    await firstStarted;
    expect(snapshots).toHaveLength(1);

    pendingWrites[0]();
    await first;
    await secondStarted;
    expect(snapshots[1]?.map((record) => record.token).sort()).toEqual([
      "android-token",
      "ios-token",
    ]);
    pendingWrites[1]();
    await second;

    const fresh = new PushTokenRegistry(runtime);
    expect((await fresh.list()).map((record) => record.token).sort()).toEqual([
      "android-token",
      "ios-token",
    ]);
  });

  it("evicts the oldest unique token once the per-agent cap is exceeded", async () => {
    for (let i = 0; i < MAX_PUSH_TOKENS_PER_AGENT; i++) {
      await registry.register("ios", `tok-${i}`);
    }
    expect(await registry.count()).toBe(MAX_PUSH_TOKENS_PER_AGENT);

    await registry.register("android", "tok-newest");
    const list = await registry.list();
    expect(list).toHaveLength(MAX_PUSH_TOKENS_PER_AGENT);
    expect(list.map((r) => r.token)).toContain("tok-newest");
    expect(list.map((r) => r.token)).not.toContain("tok-0");
    expect(list.map((r) => r.token)).toContain("tok-1");

    const persisted = ctx.cache.get(
      "push-tokens:00000000-0000-0000-0000-0000000000aa",
    ) as PushTokenRecord[];
    expect(persisted).toHaveLength(MAX_PUSH_TOKENS_PER_AGENT);
    expect(persisted.map((r) => r.token)).not.toContain("tok-0");
  });

  it("does not grow the registry when an existing token is re-registered at the cap", async () => {
    for (let i = 0; i < MAX_PUSH_TOKENS_PER_AGENT; i++) {
      await registry.register("ios", `tok-${i}`);
    }
    await registry.register("android", "tok-0");
    const list = await registry.list();
    expect(list).toHaveLength(MAX_PUSH_TOKENS_PER_AGENT);
    expect(list.find((r) => r.token === "tok-0")?.platform).toBe("android");
  });

  it("hydrates only the newest capped records from an oversized cache dump", async () => {
    const dumped: PushTokenRecord[] = [];
    for (let i = 0; i < MAX_PUSH_TOKENS_PER_AGENT + 40; i++) {
      dumped.push({
        token: `old-${i}`,
        platform: "ios",
        createdAt: i + 1,
      });
    }
    ctx.cache.set("push-tokens:00000000-0000-0000-0000-0000000000aa", dumped);
    const fresh = new PushTokenRegistry(ctx.runtime);
    const list = await fresh.list();
    expect(list).toHaveLength(MAX_PUSH_TOKENS_PER_AGENT);
    expect(list.map((r) => r.token)).toContain(
      `old-${MAX_PUSH_TOKENS_PER_AGENT + 39}`,
    );
    expect(list.map((r) => r.token)).not.toContain("old-0");
  });

  it("rejects a token longer than the byte cap", async () => {
    const huge = "x".repeat(MAX_PUSH_TOKEN_BYTES + 1);
    await expect(registry.register("ios", huge)).rejects.toThrow(/byte cap/);
    expect(await registry.count()).toBe(0);
  });

  it("bounds tokens by UTF-8 byte length, not char length", async () => {
    // '€' encodes to 3 UTF-8 bytes, so a char-length check would accept a token
    // over the byte cap. Register the largest token that fits by bytes, then one
    // char more (still tiny by char count) and confirm it is rejected.
    const maxChars = Math.floor(MAX_PUSH_TOKEN_BYTES / 3);
    const atLimit = "€".repeat(maxChars);
    expect(Buffer.byteLength(atLimit, "utf8")).toBeLessThanOrEqual(
      MAX_PUSH_TOKEN_BYTES,
    );
    await registry.register("ios", atLimit);
    expect(await registry.count()).toBe(1);

    const overByBytes = "€".repeat(maxChars + 1);
    expect(overByBytes.length).toBeLessThan(MAX_PUSH_TOKEN_BYTES);
    expect(Buffer.byteLength(overByBytes, "utf8")).toBeGreaterThan(
      MAX_PUSH_TOKEN_BYTES,
    );
    await expect(registry.register("android", overByBytes)).rejects.toThrow(
      /byte cap/,
    );
    expect(await registry.count()).toBe(1);
  });

  it("rejects hydrated records with malformed timestamps", async () => {
    ctx.cache.set(KEY, [
      { token: "ok", platform: "ios", createdAt: 5 },
      { token: "nan", platform: "ios", createdAt: Number.NaN },
      { token: "inf", platform: "ios", createdAt: Number.POSITIVE_INFINITY },
      { token: "negative", platform: "ios", createdAt: -1 },
      { token: "fractional", platform: "ios", createdAt: 1.5 },
      {
        token: "unsafe",
        platform: "ios",
        createdAt: Number.MAX_SAFE_INTEGER + 1,
      },
      { token: "stringified", platform: "ios", createdAt: "5" },
    ]);
    const fresh = new PushTokenRegistry(ctx.runtime);
    expect((await fresh.list()).map((r) => r.token)).toEqual(["ok"]);
  });

  it("drops hydrated records whose token exceeds the UTF-8 byte cap", async () => {
    ctx.cache.set(KEY, [
      { token: "small", platform: "ios", createdAt: 1 },
      {
        token: "€".repeat(Math.floor(MAX_PUSH_TOKEN_BYTES / 3) + 1),
        platform: "android",
        createdAt: 2,
      },
    ]);
    const fresh = new PushTokenRegistry(ctx.runtime);
    expect((await fresh.list()).map((r) => r.token)).toEqual(["small"]);
  });

  it("dedups before capping so duplicate-heavy data does not underfill", async () => {
    // Naive cap-then-dedup would keep only the single hottest token (its 64
    // newest duplicates fill the cap, then collapse to one). Dedup-before-cap
    // must retain the newest hot record PLUS every unique older token.
    const dump: PushTokenRecord[] = [];
    for (let i = 0; i < MAX_PUSH_TOKENS_PER_AGENT; i++) {
      dump.push({ token: "hot", platform: "ios", createdAt: 1000 + i });
    }
    for (let i = 0; i < 40; i++) {
      dump.push({ token: `uniq-${i}`, platform: "android", createdAt: 1 + i });
    }
    ctx.cache.set(KEY, dump);
    const fresh = new PushTokenRegistry(ctx.runtime);
    const list = await fresh.list();
    expect(list).toHaveLength(41);
    expect(list.find((r) => r.token === "hot")?.createdAt).toBe(1063);
    expect(list.filter((r) => r.token.startsWith("uniq-"))).toHaveLength(40);
  });

  it("hydrates exactly at the persisted-record ceiling but fails closed above it", async () => {
    const makeDump = (n: number): PushTokenRecord[] =>
      Array.from({ length: n }, (_, i) => ({
        token: `t-${i}`,
        platform: "ios" as const,
        createdAt: i + 1,
      }));

    // Exactly at the ceiling: traversed, deduped, capped to the live cap.
    ctx.cache.set(KEY, makeDump(MAX_PERSISTED_PUSH_TOKENS));
    const atCeiling = new PushTokenRegistry(ctx.runtime);
    expect(await atCeiling.count()).toBe(MAX_PUSH_TOKENS_PER_AGENT);

    // One above the ceiling: fail closed to empty and DO NOT destroy the
    // durable row (a later mutation overwrites it with a bounded array).
    const over = createRuntime();
    const oversized = makeDump(MAX_PERSISTED_PUSH_TOKENS + 1);
    over.cache.set(KEY, oversized);
    const aboveCeiling = new PushTokenRegistry(over.runtime);
    expect(await aboveCeiling.count()).toBe(0);
    expect((over.cache.get(KEY) as PushTokenRecord[]).length).toBe(
      MAX_PERSISTED_PUSH_TOKENS + 1,
    );
  });

  it("persists the repaired form exactly once and never rewrites a clean load", async () => {
    const setCalls: PushTokenRecord[][] = [];
    const cache = new Map<string, unknown>();
    cache.set(KEY, [
      { token: "  spaced  ", platform: "ios", createdAt: 2, extra: "junk" },
      { token: "dupe", platform: "android", createdAt: 1 },
      { token: "dupe", platform: "android", createdAt: 9 },
      { token: "", platform: "ios", createdAt: 3 },
    ]);
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      getCache: async <T>(k: string): Promise<T | undefined> =>
        cache.get(k) as T | undefined,
      setCache: async <T>(k: string, value: T): Promise<boolean> => {
        setCalls.push(value as PushTokenRecord[]);
        cache.set(k, value);
        return true;
      },
    });

    const first = new PushTokenRegistry(runtime);
    const list = await first.list();
    expect(list.map((r) => r.token).sort()).toEqual(["dupe", "spaced"]);
    expect(setCalls).toHaveLength(1);
    const repaired = setCalls[0];
    expect(repaired.find((r) => r.token === "dupe")?.createdAt).toBe(9);
    for (const record of repaired) {
      expect(Object.keys(record).sort()).toEqual([
        "createdAt",
        "platform",
        "token",
      ]);
    }

    // A second cold registry over the already-repaired cache must not rewrite.
    const second = new PushTokenRegistry(runtime);
    await second.list();
    expect(setCalls).toHaveLength(1);
  });

  it("rolls the in-memory registry back when a durable write is rejected", async () => {
    let failNextWrite = false;
    const cache = new Map<string, unknown>();
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      getCache: async <T>(k: string): Promise<T | undefined> =>
        cache.get(k) as T | undefined,
      setCache: async <T>(k: string, value: T): Promise<boolean> => {
        if (failNextWrite) throw new Error("cache offline");
        cache.set(k, value);
        return true;
      },
    });
    const reg = new PushTokenRegistry(runtime);
    await reg.register("ios", "keep");
    expect(await reg.count()).toBe(1);

    failNextWrite = true;
    await reg.register("android", "reject-me").then(
      () => {
        throw new Error("expected the rejected write to throw");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ElizaError);
        expect((err as ElizaError).code).toBe(PUSH_TOKEN_PERSIST_FAILED_CODE);
        // Tokens are never leaked into the error surface.
        expect(String((err as ElizaError).message)).not.toContain("reject-me");
        expect(JSON.stringify((err as ElizaError).context)).not.toContain(
          "reject-me",
        );
      },
    );
    failNextWrite = false;

    // In-memory registry unchanged (rejected token absent, prior token intact).
    expect((await reg.list()).map((r) => r.token)).toEqual(["keep"]);
    // Durable cache never received the rejected token either.
    expect((cache.get(KEY) as PushTokenRecord[]).map((r) => r.token)).toEqual([
      "keep",
    ]);
  });

  it("keeps processing later mutations after a failed one (no queue wedge)", async () => {
    let failCount = 0;
    const cache = new Map<string, unknown>();
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      getCache: async <T>(k: string): Promise<T | undefined> =>
        cache.get(k) as T | undefined,
      setCache: async <T>(k: string, value: T): Promise<boolean> => {
        if (failCount > 0) {
          failCount--;
          throw new Error("transient cache failure");
        }
        cache.set(k, value);
        return true;
      },
    });
    const reg = new PushTokenRegistry(runtime);
    await reg.register("ios", "a");

    failCount = 1;
    const failing = reg.register("android", "b");
    const following = reg.register("ios", "c");
    await expect(failing).rejects.toThrow(/persist/);
    // The queue is not wedged: the op enqueued after the failure still resolves.
    await following;

    expect((await reg.list()).map((r) => r.token).sort()).toEqual(["a", "c"]);
    expect(
      (cache.get(KEY) as PushTokenRecord[]).map((r) => r.token).sort(),
    ).toEqual(["a", "c"]);
  });

  it("never exposes an uncommitted mutation while its write is pending, and stays unchanged on rejection", async () => {
    const cache = new Map<string, unknown>();
    let gateNextWrite = false;
    let rejectPendingWrite!: (reason: Error) => void;
    let pendingWriteStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      pendingWriteStarted = resolve;
    });
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      getCache: async <T>(k: string): Promise<T | undefined> =>
        cache.get(k) as T | undefined,
      setCache: <T>(k: string, value: T): Promise<boolean> => {
        if (!gateNextWrite) {
          cache.set(k, value);
          return Promise.resolve(true);
        }
        return new Promise<boolean>((_resolve, reject) => {
          rejectPendingWrite = reject;
          pendingWriteStarted();
        });
      },
    });
    const reg = new PushTokenRegistry(runtime);
    await reg.register("ios", "keep");
    expect(await reg.count()).toBe(1);

    gateNextWrite = true;
    const pending = reg.register("android", "pending-token");
    await started;
    // The candidate is staged but not published: readers observe only committed
    // state while the durable write is in flight.
    expect(await reg.count()).toBe(1);
    expect((await reg.list()).map((r) => r.token)).toEqual(["keep"]);

    rejectPendingWrite(new Error("cache offline"));
    await pending.then(
      () => {
        throw new Error("expected the rejected write to throw");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ElizaError);
        expect((err as ElizaError).code).toBe(PUSH_TOKEN_PERSIST_FAILED_CODE);
      },
    );

    // Observable registry and durable cache are unchanged after the rejection.
    expect((await reg.list()).map((r) => r.token)).toEqual(["keep"]);
    expect((cache.get(KEY) as PushTokenRecord[]).map((r) => r.token)).toEqual([
      "keep",
    ]);
  });

  it("rejects an unsupported platform from a direct caller with a typed error", async () => {
    const untyped = registry as unknown as {
      register(platform: unknown, token: string): Promise<void>;
    };
    await untyped.register("web", "tok-web").then(
      () => {
        throw new Error("expected unsupported platform to reject");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ElizaError);
        expect((err as ElizaError).code).toBe(PUSH_TOKEN_INVALID_CODE);
      },
    );
    expect(await registry.count()).toBe(0);
    expect(ctx.cache.get(KEY)).toBeUndefined();
  });

  it("turns a non-string runtime token into the typed invalid error, not a TypeError", async () => {
    const untyped = registry as unknown as {
      register(platform: string, token: unknown): Promise<void>;
    };
    await untyped.register("ios", 12345).then(
      () => {
        throw new Error("expected a non-string token to reject");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ElizaError);
        expect((err as ElizaError).code).toBe(PUSH_TOKEN_INVALID_CODE);
      },
    );
    expect(await registry.count()).toBe(0);
  });

  it("rejects an empty token with a typed validation error", async () => {
    await registry.register("ios", "real").catch(() => undefined);
    await registry.register("ios", "   ").then(
      () => {
        throw new Error("expected empty token to reject");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ElizaError);
        expect((err as ElizaError).code).toBe(PUSH_TOKEN_INVALID_CODE);
      },
    );
  });
});
