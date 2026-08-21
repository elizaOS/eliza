/**
 * PendingPromptsService unit test — the runtime-owned pending-prompts store.
 *
 * Mirrors the LifeOps store integration test: record on fire, surface via the
 * store, resolve on a terminal verb, and the retain-window expiry. Exercised
 * through the registered service's `getStore()` accessor so the promotion to a
 * runtime service preserves the cache-backed contract the scheduler reads.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
import { describe, expect, it } from "vitest";
import {
  PendingPromptsService,
  resolvePendingPromptsService,
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

describe("PendingPromptsService", () => {
  it("starts and exposes a cache-backed store", async () => {
    const runtime = makeRuntime();
    const service = await PendingPromptsService.start(runtime);
    expect(service).toBeInstanceOf(PendingPromptsService);

    const store = service.getStore();
    const roomId = "room-checkin-1";
    await store.record({
      taskId: "task-checkin-1",
      roomId,
      promptSnippet: "How are you feeling today?",
      firedAt: new Date().toISOString(),
      expectedReplyKind: "free_form",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });

    const list = await store.list(roomId);
    expect(list.length).toBe(1);
    expect(list[0]?.taskId).toBe("task-checkin-1");

    await store.resolve(roomId, "task-checkin-1");
    expect((await store.list(roomId)).length).toBe(0);

    await service.stop();
  });

  it("does not drop a concurrent record() under a raced cache read", async () => {
    const cache = new Map<string, unknown>();
    let releaseFirstRead: (() => void) | undefined;
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let roomReadCount = 0;
    const runtime = {
      agentId: "test-agent",
      async getCache<T>(key: string): Promise<T | null> {
        if (key.startsWith("eliza:lifeops:pending-prompts:room:")) {
          roomReadCount += 1;
          // Snapshot the value now (as a real round-trip would capture it at
          // request time), then delay only the response -- so a concurrent
          // write that lands during the delay is invisible to this read.
          const snapshot = cache.get(key);
          if (roomReadCount === 1) {
            await firstReadGate;
          }
          return snapshot === undefined ? null : (snapshot as T);
        }
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

    const service = await PendingPromptsService.start(runtime);
    const store = service.getStore();
    const roomId = "room-race";
    const firedAt = new Date().toISOString();

    // Two concurrent record() calls for the same room: the first's room read
    // is held open (simulating a slow/interleaved cache round-trip) while the
    // second's own record() call runs to completion, then the first is
    // released. Without a lock serializing the read-modify-write, the first
    // call's stale (pre-second-write) snapshot overwrites the second's entry.
    const first = store.record({
      taskId: "task-a",
      roomId,
      promptSnippet: "first",
      firedAt,
    });
    const second = store.record({
      taskId: "task-b",
      roomId,
      promptSnippet: "second",
      firedAt,
    });
    // Let second's unblocked read-modify-write chain fully drain (a macrotask
    // boundary flushes every pending microtask) before releasing first's
    // gated read.
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirstRead?.();
    await Promise.all([first, second]);

    const stored = await store.list(roomId);
    expect(stored.map((entry) => entry.taskId).sort()).toEqual([
      "task-a",
      "task-b",
    ]);

    await service.stop();
  });

  it("lists pending prompts across rooms as canonical pending user actions", async () => {
    const runtime = makeRuntime();
    const service = await PendingPromptsService.start(runtime);
    const store = service.getStore();
    const now = Date.now();
    const taskAFiredAt = new Date(now - 5 * 60_000).toISOString();
    const taskBFiredAt = new Date(now).toISOString();
    const taskAExpiresAt = new Date(now + 60 * 60_000).toISOString();
    await store.record({
      taskId: "task-a",
      roomId: "room-a",
      promptSnippet: "Approve the calendar change?",
      firedAt: taskAFiredAt,
      expectedReplyKind: "approval",
      expiresAt: taskAExpiresAt,
    });
    await store.record({
      taskId: "task-b",
      roomId: "room-b",
      promptSnippet: "How did lunch go?",
      firedAt: taskBFiredAt,
      expectedReplyKind: "free_form",
    });

    expect(await store.listAll()).toEqual([
      expect.objectContaining({ taskId: "task-b", roomId: "room-b" }),
      expect.objectContaining({ taskId: "task-a", roomId: "room-a" }),
    ]);
    expect(await service.listPendingUserActions()).toEqual([
      expect.objectContaining({
        id: "task-b",
        kind: "pending_prompt",
        roomId: "room-b",
        expectedReplyKind: "free_form",
        weight: 6,
        resolution: { target: "pending_prompt", requestId: "task-b" },
      }),
      expect.objectContaining({
        id: "task-a",
        kind: "pending_prompt",
        roomId: "room-a",
        expectedReplyKind: "approval",
        weight: 9,
        expiresAt: Date.parse(taskAExpiresAt),
      }),
    ]);
  });

  it("retains expired prompts only within the reopen window", async () => {
    const runtime = makeRuntime();
    const store = (await PendingPromptsService.start(runtime)).getStore();
    const roomId = "room-checkin-2";
    await store.record({
      taskId: "task-old",
      roomId,
      promptSnippet: "old",
      firedAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
      expiresAt: new Date(Date.now() - 24.5 * 3_600_000).toISOString(),
      reopenWindowHours: 24,
    });
    expect((await store.list(roomId)).length).toBe(0);
  });

  it("lists open prompts across indexed rooms newest-first", async () => {
    const runtime = makeRuntime();
    const store = (await PendingPromptsService.start(runtime)).getStore();
    await store.record({
      taskId: "task-older",
      roomId: "room-a",
      promptSnippet: "older prompt",
      firedAt: "2026-06-24T18:00:00.000Z",
      expectedReplyKind: "free_form",
    });
    await store.record({
      taskId: "task-newer",
      roomId: "room-b",
      promptSnippet: "newer prompt",
      firedAt: "2026-06-24T18:05:00.000Z",
      expectedReplyKind: "approval",
    });
    await store.record({
      taskId: "task-expired",
      roomId: "room-c",
      promptSnippet: "expired prompt",
      firedAt: "2026-06-23T18:00:00.000Z",
      expiresAt: "2026-06-23T18:01:00.000Z",
      reopenWindowHours: 1,
    });

    expect(
      await store.listAll({ now: new Date("2026-06-24T18:10:00.000Z") }),
    ).toEqual([
      expect.objectContaining({ taskId: "task-newer", roomId: "room-b" }),
      expect.objectContaining({ taskId: "task-older", roomId: "room-a" }),
    ]);
  });

  it("resolvePendingPromptsService returns null when unregistered", () => {
    const runtime = createMockRuntime({
      getService: () => null,
    });
    expect(resolvePendingPromptsService(runtime)).toBeNull();
  });
});
