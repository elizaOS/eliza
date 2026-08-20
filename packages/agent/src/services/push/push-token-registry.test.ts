/**
 * Covers the push-token registry: register/list/count/unregister, idempotent
 * upsert, moving a token between platforms, whitespace trimming and empty-token
 * rejection, platform filtering, cache-backed persistence with rehydration, and
 * dropping malformed records on hydrate, concurrent first-use hydration, and
 * serialized persistence. Backed by a Map-backed mock runtime cache — no real
 * storage.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PUSH_TOKEN_LENGTH,
  MAX_PUSH_TOKENS_PER_AGENT,
  type PushTokenRecord,
  PushTokenRegistry,
} from "./push-token-registry.ts";

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
    ctx.cache.set(
      "push-tokens:00000000-0000-0000-0000-0000000000aa",
      dumped,
    );
    const fresh = new PushTokenRegistry(ctx.runtime);
    const list = await fresh.list();
    expect(list).toHaveLength(MAX_PUSH_TOKENS_PER_AGENT);
    expect(list.map((r) => r.token)).toContain(
      `old-${MAX_PUSH_TOKENS_PER_AGENT + 39}`,
    );
    expect(list.map((r) => r.token)).not.toContain("old-0");
  });

  it("rejects a token longer than the length cap", async () => {
    const huge = "x".repeat(MAX_PUSH_TOKEN_LENGTH + 1);
    await expect(registry.register("ios", huge)).rejects.toThrow(/length cap/);
    expect(await registry.count()).toBe(0);
  });
});
