/** Verifies indexed pending-prompt rooms retire when empty while live room behavior remains stable, using a deterministic serialized cache double. */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, test } from "vitest";
import { createPendingPromptsStore } from "./store.ts";

const ROOM_INDEX_KEY = "eliza:lifeops:pending-prompts:rooms:v1";
const roomCacheKey = (roomId: string) =>
  `eliza:lifeops:pending-prompts:room:${roomId}:v1`;

interface CacheDouble {
  runtime: IAgentRuntime;
  store: Map<string, string>;
  getCalls: string[];
  index(): string[];
  failNextIndexWrite(): void;
}

function makeCache(): CacheDouble {
  const store = new Map<string, string>();
  const getCalls: string[] = [];
  let shouldFailIndexWrite = false;
  const runtime = {
    agentId: "agent-under-test",
    // The real cache round-trips through the adapter, so serialize rather than
    // handing back live references.
    getCache: async <T>(key: string): Promise<T | undefined> => {
      getCalls.push(key);
      const raw = store.get(key);
      return raw === undefined ? undefined : (JSON.parse(raw) as T);
    },
    setCache: async <T>(key: string, value: T): Promise<boolean> => {
      if (key === ROOM_INDEX_KEY && shouldFailIndexWrite) {
        shouldFailIndexWrite = false;
        throw new Error("cache index write failed");
      }
      store.set(key, JSON.stringify(value));
      return true;
    },
    deleteCache: async (key: string): Promise<boolean> => store.delete(key),
  } as unknown as IAgentRuntime;

  return {
    runtime,
    store,
    getCalls,
    failNextIndexWrite(): void {
      shouldFailIndexWrite = true;
    },
    index(): string[] {
      const raw = store.get(ROOM_INDEX_KEY);
      return raw === undefined ? [] : (JSON.parse(raw) as string[]);
    },
  };
}

const firedAt = "2026-08-22T00:00:00.000Z";

describe("pending-prompts room index", () => {
  test("500 recorded-then-resolved rooms leave an empty index and no cache rows", async () => {
    const cache = makeCache();
    const store = createPendingPromptsStore(cache.runtime);

    for (let i = 0; i < 500; i += 1) {
      await store.record({
        roomId: `room-${i}`,
        taskId: `task-${i}`,
        promptSnippet: "did you do the thing?",
        firedAt,
      });
    }
    expect(cache.index()).toHaveLength(500);

    for (let i = 0; i < 500; i += 1) {
      await store.resolve(`room-${i}`, `task-${i}`);
    }

    expect(cache.index()).toHaveLength(0);
    expect(cache.store.has(roomCacheKey("room-0"))).toBe(false);
    expect(cache.store.has(roomCacheKey("room-499"))).toBe(false);

    // And the follow-on cost: listAll() reads the index, then one row per
    // indexed room. With every room retired that is a single read.
    cache.getCalls.length = 0;
    await expect(store.listAll()).resolves.toEqual([]);
    expect(cache.getCalls).toEqual([ROOM_INDEX_KEY]);
  });

  test("listAll retires empty rooms persisted by the pre-fix implementation", async () => {
    const cache = makeCache();
    const store = createPendingPromptsStore(cache.runtime);
    cache.store.set(ROOM_INDEX_KEY, JSON.stringify(["legacy-room"]));
    cache.store.set(roomCacheKey("legacy-room"), JSON.stringify([]));

    await expect(store.listAll()).resolves.toEqual([]);

    expect(cache.index()).toEqual([]);
    expect(cache.store.has(roomCacheKey("legacy-room"))).toBe(false);
  });

  test("resolve retry finishes retirement after the row delete succeeds but the index write fails", async () => {
    const cache = makeCache();
    const store = createPendingPromptsStore(cache.runtime);
    await store.record({
      roomId: "room-a",
      taskId: "task-a",
      promptSnippet: "resolve me",
      firedAt,
    });
    cache.failNextIndexWrite();

    await expect(store.resolve("room-a", "task-a")).rejects.toThrow(
      "cache index write failed",
    );
    expect(cache.store.has(roomCacheKey("room-a"))).toBe(false);
    expect(cache.index()).toEqual(["room-a"]);

    await expect(store.resolve("room-a", "task-a")).resolves.toBeUndefined();
    expect(cache.index()).toEqual([]);
    expect(cache.store.has(roomCacheKey("room-a"))).toBe(false);
  });

  test("the retain-window purge in list() retires the room it empties", async () => {
    const cache = makeCache();
    const store = createPendingPromptsStore(cache.runtime);

    await store.record({
      roomId: "room-a",
      taskId: "task-a",
      promptSnippet: "expiring",
      firedAt,
      reopenWindowHours: 1,
    });
    expect(cache.index()).toEqual(["room-a"]);

    // Two hours past the one-hour reopen window.
    const later = new Date(Date.parse(firedAt) + 2 * 3_600_000);
    await expect(store.list("room-a", { now: later })).resolves.toEqual([]);

    expect(cache.index()).toEqual([]);
    expect(cache.store.has(roomCacheKey("room-a"))).toBe(false);
  });

  test("forgetTask retires the rooms it empties and keeps the ones it does not", async () => {
    const cache = makeCache();
    const store = createPendingPromptsStore(cache.runtime);

    await store.record({
      roomId: "room-a",
      taskId: "shared-task",
      promptSnippet: "a",
      firedAt,
    });
    await store.record({
      roomId: "room-b",
      taskId: "shared-task",
      promptSnippet: "b",
      firedAt,
    });
    await store.record({
      roomId: "room-b",
      taskId: "other-task",
      promptSnippet: "b2",
      firedAt,
    });

    await store.forgetTask("shared-task");

    expect(cache.index()).toEqual(["room-b"]);
    expect(cache.store.has(roomCacheKey("room-a"))).toBe(false);
    const remaining = await store.list("room-b");
    expect(remaining.map((p) => p.taskId)).toEqual(["other-task"]);
  });

  // ---- no over-rejection: rooms with live prompts are untouched ----

  test("a room keeps its index entry while any prompt remains", async () => {
    const cache = makeCache();
    const store = createPendingPromptsStore(cache.runtime);

    await store.record({
      roomId: "room-a",
      taskId: "task-1",
      promptSnippet: "first",
      firedAt,
    });
    await store.record({
      roomId: "room-a",
      taskId: "task-2",
      promptSnippet: "second",
      firedAt,
    });

    await store.resolve("room-a", "task-1");

    expect(cache.index()).toEqual(["room-a"]);
    const remaining = await store.list("room-a");
    expect(remaining.map((p) => p.taskId)).toEqual(["task-2"]);
  });

  test("record/list/listAll still behave across live rooms", async () => {
    const cache = makeCache();
    const store = createPendingPromptsStore(cache.runtime);

    await store.record({
      roomId: "room-a",
      taskId: "task-a",
      promptSnippet: "  ping a  ",
      firedAt: "2026-08-22T00:00:00.000Z",
    });
    await store.record({
      roomId: "room-b",
      taskId: "task-b",
      promptSnippet: "ping b",
      firedAt: "2026-08-22T01:00:00.000Z",
      expiresAt: "2026-08-22T02:00:00.000Z",
      expectedReplyKind: "yes_no",
    });

    expect(cache.index().slice().sort()).toEqual(["room-a", "room-b"]);

    const roomA = await store.list("room-a");
    expect(roomA).toEqual([
      {
        taskId: "task-a",
        promptSnippet: "ping a",
        firedAt: "2026-08-22T00:00:00.000Z",
        expectedReplyKind: "any",
      },
    ]);

    const all = await store.listAll();
    // Newest first.
    expect(all.map((p) => [p.roomId, p.taskId])).toEqual([
      ["room-b", "task-b"],
      ["room-a", "task-a"],
    ]);
    expect(all[0]?.expiresAt).toBe("2026-08-22T02:00:00.000Z");
    expect(all[0]?.expectedReplyKind).toBe("yes_no");
  });

  test("re-recording the same task in a room replaces it without churning the index", async () => {
    const cache = makeCache();
    const store = createPendingPromptsStore(cache.runtime);

    await store.record({
      roomId: "room-a",
      taskId: "task-a",
      promptSnippet: "first",
      firedAt,
    });
    await store.record({
      roomId: "room-a",
      taskId: "task-a",
      promptSnippet: "second",
      firedAt,
    });

    expect(cache.index()).toEqual(["room-a"]);
    const listed = await store.list("room-a");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.promptSnippet).toBe("second");
  });

  test("resolving a task that is not there leaves the room and index alone", async () => {
    const cache = makeCache();
    const store = createPendingPromptsStore(cache.runtime);

    await store.record({
      roomId: "room-a",
      taskId: "task-a",
      promptSnippet: "still open",
      firedAt,
    });

    await store.resolve("room-a", "task-that-was-never-recorded");

    expect(cache.index()).toEqual(["room-a"]);
    expect((await store.list("room-a")).map((p) => p.taskId)).toEqual([
      "task-a",
    ]);
  });

  test("clearAll still empties everything", async () => {
    const cache = makeCache();
    const store = createPendingPromptsStore(cache.runtime);

    await store.record({
      roomId: "room-a",
      taskId: "task-a",
      promptSnippet: "a",
      firedAt,
    });
    await store.record({
      roomId: "room-b",
      taskId: "task-b",
      promptSnippet: "b",
      firedAt,
    });

    await store.clearAll();

    expect(cache.index()).toEqual([]);
    expect(cache.store.has(roomCacheKey("room-a"))).toBe(false);
    expect(cache.store.has(roomCacheKey("room-b"))).toBe(false);
    await expect(store.listAll()).resolves.toEqual([]);
  });
});
