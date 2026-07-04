/**
 * Covers the push-token registry: register/list/count/unregister, idempotent
 * upsert, moving a token between platforms, whitespace trimming and empty-token
 * rejection, platform filtering, cache-backed persistence with rehydration, and
 * dropping malformed records on hydrate. Backed by a Map-backed mock runtime
 * cache — no real storage.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { PushTokenRegistry } from "./push-token-registry.ts";

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
});
