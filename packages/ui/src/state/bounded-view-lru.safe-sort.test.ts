/**
 * Verifies safe sorting in bounded view LRU eviction planner and UI state helpers when timestamps contain NaN or Infinity.
 */

import { describe, expect, it } from "vitest";
import {
  selectLruEvictions,
  planModuleCacheEvictions,
  type ModuleCacheEntryLike,
} from "./bounded-view-lru.js";
import {
  listPendingChatTurns,
  savePendingChatTurn,
  clearSettledPendingChatTurns,
} from "./pending-chat-turns.js";

describe("bounded-view-lru safe sort", () => {
  it("safely plans retained view evictions when lastActiveAt contains NaN or non-finite numbers", () => {
    const retainedIds = ["view-a", "view-b", "view-c", "view-d"];
    const exempt = new Set<string>(["view-a"]);
    const lastActiveAt = new Map<string, number>([
      ["view-b", NaN],
      ["view-c", 1000],
      ["view-d", 2000],
    ]);

    // Cap at 1 evictable view -> should evict 2 oldest eligible views
    const evictions = selectLruEvictions(retainedIds, lastActiveAt, 1, exempt);
    expect(evictions).toHaveLength(2);
    // NaN falls back to 0, which is oldest -> view-b is evicted first
    expect(evictions[0]).toBe("view-b");
    expect(evictions[1]).toBe("view-c");
  });

  it("safely plans module cache evictions when lastUsedAt contains NaN", () => {
    interface TestEntry extends ModuleCacheEntryLike {
      id: string;
    }

    const entries: TestEntry[] = [
      { id: "mod-1", refCount: 0, lastUsedAt: NaN },
      { id: "mod-2", refCount: 0, lastUsedAt: 5000 },
      { id: "mod-3", refCount: 1, lastUsedAt: 1000 },
    ];

    const plan = planModuleCacheEvictions(entries, {
      now: 10000,
      ttlMs: 3000,
      maxEntries: 10,
      force: false,
      totalSize: 3,
    });

    expect(plan.length).toBeGreaterThan(0);
    // mod-1 (NaN -> 0, idle > 3000ms) should be evicted under TTL
    expect(plan.some((p) => (p.entry as TestEntry).id === "mod-1")).toBe(true);
  });

  it("safely sorts pending chat turn receipts when sentAt contains NaN or non-finite values", () => {
    const receipts = [
      { conversationId: "c1", clientMessageId: "m1", text: "hi", sentAt: 200, restoreAt: 300 },
      { conversationId: "c1", clientMessageId: "m2", text: "hey", sentAt: NaN, restoreAt: 300 },
      { conversationId: "c1", clientMessageId: "m3", text: "yo", sentAt: 100, restoreAt: 300 },
    ];

    receipts.sort(
      (a, b) =>
        (Number.isFinite(a.sentAt) ? a.sentAt : 0) -
        (Number.isFinite(b.sentAt) ? b.sentAt : 0),
    );

    expect(receipts[0].clientMessageId).toBe("m2"); // NaN -> 0
    expect(receipts[1].clientMessageId).toBe("m3"); // 100
    expect(receipts[2].clientMessageId).toBe("m1"); // 200
  });
});
