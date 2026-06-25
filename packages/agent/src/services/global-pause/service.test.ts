/**
 * GlobalPauseService unit test — the runtime-owned vacation / pause singleton.
 *
 * Mirrors the LifeOps store integration test: set the window, current()
 * reflects active state inside the window, and clear() returns to inactive.
 * Exercised through the registered service's `getStore()` accessor.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
import { describe, expect, it } from "vitest";
import {
  GLOBAL_PAUSE_SERVICE,
  GlobalPauseService,
  resolveGlobalPauseService,
} from "./service.ts";

function makeRuntime(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "test-agent",
    async getCache<T>(key: string): Promise<T | null> {
      const value = cache.get(key);
      return value === undefined ? null : (value as T);
    },
    async setCache<T>(key: string, value: T): Promise<boolean> {
      cache.set(key, value);
      return true;
    },
    async deleteCache(key: string): Promise<boolean> {
      return cache.delete(key);
    },
  } as unknown as IAgentRuntime;
}

describe("GlobalPauseService", () => {
  it("exposes the canonical serviceType literal", () => {
    expect(GlobalPauseService.serviceType).toBe("eliza_global_pause");
    expect(GLOBAL_PAUSE_SERVICE).toBe("eliza_global_pause");
  });

  it("set + current + clear lifecycle works through the service store", async () => {
    const runtime = makeRuntime();
    const service = await GlobalPauseService.start(runtime);
    const store = service.getStore();

    expect((await store.current()).active).toBe(false);

    const startIso = new Date(Date.now() - 60_000).toISOString();
    const endIso = new Date(Date.now() + 86_400_000).toISOString();
    await store.set({ startIso, endIso, reason: "vacation" });

    const active = await store.current();
    expect(active.active).toBe(true);
    expect(active.reason).toBe("vacation");
    expect(active.startIso).toBe(startIso);
    expect(active.endIso).toBe(endIso);

    const afterEnd = await store.current(new Date(Date.parse(endIso) + 1));
    expect(afterEnd.active).toBe(false);

    await store.clear();
    expect((await store.current()).active).toBe(false);

    await service.stop();
  });

  it("resolveGlobalPauseService returns null when unregistered", () => {
    const runtime = createMockRuntime({
      getService: () => null,
    });
    expect(resolveGlobalPauseService(runtime)).toBeNull();
  });
});
