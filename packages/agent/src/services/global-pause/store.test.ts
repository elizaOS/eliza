/**
 * Unit tests for GlobalPauseStore validation, activation checks, reason
 * normalization, open-ended windows, and cache persistence boundaries.
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

  it("supports open-ended pause windows without endIso", async () => {
    const runtime = makeMockRuntime();
    const store = createGlobalPauseStore(runtime);

    const start = new Date(Date.now() - 5000).toISOString();
    await store.set({
      startIso: start,
      reason: "Indefinite hiatus",
    });

    const statusNow = await store.current();
    expect(statusNow.active).toBe(true);
    expect(statusNow.endIso).toBeUndefined();
    expect(statusNow.reason).toBe("Indefinite hiatus");

    const statusFarFuture = await store.current(
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    );
    expect(statusFarFuture.active).toBe(true);
  });

  it("reports future startIso as inactive while preserving window metadata", async () => {
    const runtime = makeMockRuntime();
    const store = createGlobalPauseStore(runtime);

    const futureStart = new Date(Date.now() + 60000).toISOString();
    const futureEnd = new Date(Date.now() + 120000).toISOString();
    await store.set({
      startIso: futureStart,
      endIso: futureEnd,
      reason: "Scheduled maintenance",
    });

    const currentStatus = await store.current(new Date(Date.now()));
    expect(currentStatus.active).toBe(false);
    expect(currentStatus.startIso).toBe(futureStart);
    expect(currentStatus.endIso).toBe(futureEnd);
    expect(currentStatus.reason).toBe("Scheduled maintenance");
  });

  it("strictly enforces activation window start and end boundaries down to the millisecond", async () => {
    const runtime = makeMockRuntime();
    const store = createGlobalPauseStore(runtime);

    const startEpoch = 1_700_000_000_000;
    const endEpoch = 1_700_000_060_000;
    const startIso = new Date(startEpoch).toISOString();
    const endIso = new Date(endEpoch).toISOString();

    await store.set({
      startIso,
      endIso,
      reason: "Boundary test",
    });

    // 1ms before start: inactive
    const beforeStart = await store.current(new Date(startEpoch - 1));
    expect(beforeStart.active).toBe(false);

    // Exactly at start: active
    const atStart = await store.current(new Date(startEpoch));
    expect(atStart.active).toBe(true);

    // 1ms before end: active
    const beforeEnd = await store.current(new Date(endEpoch - 1));
    expect(beforeEnd.active).toBe(true);

    // Exactly at end: inactive
    const atEnd = await store.current(new Date(endEpoch));
    expect(atEnd.active).toBe(false);

    // 1ms after end: inactive
    const afterEnd = await store.current(new Date(endEpoch + 1));
    expect(afterEnd.active).toBe(false);
  });

  it("normalizes and trims reason text, dropping empty reasons", async () => {
    const runtime = makeMockRuntime();
    const store = createGlobalPauseStore(runtime);

    const start = new Date(Date.now() - 1000).toISOString();
    await store.set({
      startIso: start,
      reason: "   Trimmed reason text   ",
    });

    const status = await store.current();
    expect(status.reason).toBe("Trimmed reason text");

    await store.set({
      startIso: start,
      reason: "     ",
    });
    const blankStatus = await store.current();
    expect(blankStatus.reason).toBeUndefined();

    // Lone surrogate normalization
    await store.set({
      startIso: start,
      reason: "a\uD800b",
    });
    const surrogateStatus = await store.current();
    expect(surrogateStatus.reason).toBe("a\uFFFDb");
  });

  it("validates startIso and endIso ordering", async () => {
    const runtime = makeMockRuntime();
    const store = createGlobalPauseStore(runtime);

    // Invalid start ISO
    await expect(store.set({ startIso: "not-a-date" })).rejects.toThrowError(
      /invalid startIso/,
    );

    // Empty start ISO
    await expect(store.set({ startIso: "" })).rejects.toThrowError(
      /invalid startIso/,
    );

    // Invalid end ISO
    await expect(
      store.set({ startIso: "2026-08-20T10:00:00Z", endIso: "bad-end-date" }),
    ).rejects.toThrowError(/invalid endIso/);

    // endIso before startIso
    const start = "2026-08-20T10:00:00Z";
    const end = "2026-08-19T10:00:00Z";
    await expect(
      store.set({ startIso: start, endIso: end }),
    ).rejects.toThrowError(/endIso must be strictly after startIso/);

    // endIso equal to startIso
    await expect(
      store.set({ startIso: start, endIso: start }),
    ).rejects.toThrowError(/endIso must be strictly after startIso/);
  });

  it("degrades gracefully to inactive when cached data is invalid or corrupt", async () => {
    const runtime = makeMockRuntime();
    const store = createGlobalPauseStore(runtime);

    // Corrupt non-object cache
    await runtime.setCache(GLOBAL_PAUSE_CACHE_KEY, "not-an-object");
    expect(await store.current()).toEqual({ active: false });

    // Corrupt object missing valid startIso
    await runtime.setCache(GLOBAL_PAUSE_CACHE_KEY, {
      startIso: "invalid-iso",
      reason: "corrupt",
    });
    expect(await store.current()).toEqual({ active: false });

    // Corrupt object with unparseable endIso degrades to active: false
    const corruptStart = new Date(Date.now() - 5000).toISOString();
    await runtime.setCache(GLOBAL_PAUSE_CACHE_KEY, {
      startIso: corruptStart,
      endIso: "not-a-date",
      reason: "corrupt-end",
    });
    const corruptEndStatus = await store.current();
    expect(corruptEndStatus.active).toBe(false);
    expect(corruptEndStatus.startIso).toBe(corruptStart);
    expect(corruptEndStatus.endIso).toBe("not-a-date");
  });
});
