/**
 * Unit tests for GlobalPauseStore validation, activation checks, and cache persistence.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createGlobalPauseStore, GLOBAL_PAUSE_CACHE_KEY } from "./store.js";

function makeMockRuntime() {
  const cache = new Map<string, unknown>();
  return {
    getCache: vi
      .fn()
      .mockImplementation(async (key: string) => cache.get(key) ?? null),
    setCache: vi.fn().mockImplementation(async (key: string, val: unknown) => {
      cache.set(key, val);
    }),
    deleteCache: vi.fn().mockImplementation(async (key: string) => {
      cache.delete(key);
    }),
  } as unknown as IAgentRuntime;
}

describe("global-pause-store", () => {
  it("manages pause window lifecycle and status correctly", async () => {
    const runtime = makeMockRuntime();
    const store = createGlobalPauseStore(runtime);

    // Initially inactive
    const initial = await store.current();
    expect(initial.active).toBe(false);

    // Set pause window for vacation
    const start = new Date(Date.now() - 10000).toISOString();
    const end = new Date(Date.now() + 60000).toISOString();
    await store.set({
      startIso: start,
      endIso: end,
      reason: "On vacation in Paris",
    });

    expect(runtime.setCache).toHaveBeenCalledWith(
      GLOBAL_PAUSE_CACHE_KEY,
      expect.objectContaining({
        startIso: start,
        endIso: end,
        reason: "On vacation in Paris",
      }),
    );

    const activeStatus = await store.current();
    expect(activeStatus.active).toBe(true);
    expect(activeStatus.reason).toBe("On vacation in Paris");

    // Check status after window ends
    const futureCheck = await store.current(new Date(Date.now() + 100000));
    expect(futureCheck.active).toBe(false);

    // Clear window
    await store.clear();
    const cleared = await store.current();
    expect(cleared.active).toBe(false);
  });

  it("validates startIso and endIso ordering", async () => {
    const runtime = makeMockRuntime();
    const store = createGlobalPauseStore(runtime);

    // Invalid start ISO
    await expect(store.set({ startIso: "not-a-date" })).rejects.toThrowError(
      /invalid startIso/,
    );

    // endIso before startIso
    const start = "2026-08-20T10:00:00Z";
    const end = "2026-08-19T10:00:00Z";
    await expect(
      store.set({ startIso: start, endIso: end }),
    ).rejects.toThrowError(/endIso must be strictly after startIso/);
  });
});
