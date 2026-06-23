/**
 * PendingPromptsService unit test — the runtime-owned pending-prompts store.
 *
 * Mirrors the LifeOps store integration test: record on fire, surface via the
 * store, resolve on a terminal verb, and the retain-window expiry. Exercised
 * through the registered service's `getStore()` accessor so the promotion to a
 * runtime service preserves the cache-backed contract the scheduler reads.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  PENDING_PROMPTS_SERVICE,
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
  it("exposes the canonical serviceType literal", () => {
    expect(PendingPromptsService.serviceType).toBe("eliza_pending_prompts");
    expect(PENDING_PROMPTS_SERVICE).toBe("eliza_pending_prompts");
  });

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

  it("resolvePendingPromptsService returns null when unregistered", () => {
    const runtime = {
      getService: () => null,
    } as unknown as IAgentRuntime;
    expect(resolvePendingPromptsService(runtime)).toBeNull();
  });
});
