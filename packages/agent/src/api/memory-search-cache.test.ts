/**
 * Regression coverage for the /api/memory/search corpus + BM25 cache:
 * identical ranking cached vs cold, explicit invalidation on module-local
 * mutations (remember / DELETE / PATCH), count-based staleness detection,
 * bounded refresh failure, runtime isolation, rebuild races, and memory limits.
 */

import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MemoryRouteContext } from "./memory-routes.ts";
import {
  HASH_MEMORY_SOURCE,
  handleMemoryRoutes,
  invalidateMemorySearchCache,
} from "./memory-routes.ts";

const AGENT_ID = "11111111-1111-4111-8111-111111111111" as UUID;

type Store = { rows: Memory[] };

function note(id: string, text: string, createdAt: number): Memory {
  return {
    id: id as UUID,
    entityId: AGENT_ID,
    agentId: AGENT_ID,
    roomId: "22222222-2222-4222-8222-222222222222" as UUID,
    createdAt,
    content: { text, source: HASH_MEMORY_SOURCE },
  } as Memory;
}

function makeRuntime(store: Store) {
  const getMemories = vi.fn(async () => [...store.rows]);
  const countMemories = vi.fn(async () => store.rows.length);
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    ensureConnection: vi.fn(async () => undefined),
    getMemories,
    countMemories,
    getMemoryById: vi.fn(
      async (id: UUID) => store.rows.find((row) => row.id === id) ?? null,
    ),
    createMemory: vi.fn(async (memory: Memory) => {
      store.rows.push(memory);
      return memory.id;
    }),
    deleteMemory: vi.fn(async (id: UUID) => {
      store.rows = store.rows.filter((row) => row.id !== id);
    }),
    updateMemory: vi.fn(
      async (patch: { id: UUID; content: Record<string, unknown> }) => {
        const row = store.rows.find((r) => r.id === patch.id);
        if (row) row.content = patch.content as Memory["content"];
      },
    ),
    useModel: vi.fn(async () => [0.1, 0.2, 0.3]),
    reportError: vi.fn(() => undefined),
  } as unknown as AgentRuntime;
  return { runtime, getMemories, countMemories };
}

function contextFor(args: {
  runtime: AgentRuntime;
  method: string;
  path: string;
  body?: Record<string, unknown>;
  response: { value?: unknown };
}): MemoryRouteContext {
  return {
    req: {} as never,
    res: {} as never,
    method: args.method,
    pathname: args.path.split("?")[0] ?? args.path,
    url: new URL(`https://agent.test${args.path}`),
    runtime: args.runtime,
    agentName: "Eliza",
    json: (_res, value) => {
      args.response.value = value;
    },
    error: (_res, message, status) => {
      throw new Error(`unexpected ${status}: ${message}`);
    },
    readJsonBody: async <T extends object>() => (args.body ?? {}) as T,
  };
}

async function search(
  runtime: AgentRuntime,
  query: string,
): Promise<Array<{ id: string; text: string; score: number }>> {
  const response: { value?: unknown } = {};
  const handled = await handleMemoryRoutes(
    contextFor({
      runtime,
      method: "GET",
      path: `/api/memory/search?q=${encodeURIComponent(query)}&limit=50`,
      response,
    }),
  );
  expect(handled).toBe(true);
  return (
    response.value as {
      results: Array<{ id: string; text: string; score: number }>;
    }
  ).results;
}

beforeEach(() => {
  invalidateMemorySearchCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/memory/search corpus cache", () => {
  test("warm search reuses the corpus (no rescan) and returns identical ordering", async () => {
    const store: Store = {
      rows: [
        note(
          "aaaaaaaa-0000-4000-8000-000000000001",
          "alexis gym signup together planned",
          3,
        ),
        note(
          "aaaaaaaa-0000-4000-8000-000000000002",
          "shipping the voice pipeline tonight",
          2,
        ),
        note(
          "aaaaaaaa-0000-4000-8000-000000000003",
          "alexis prefers morning workouts at the gym",
          1,
        ),
      ],
    };
    const { runtime, getMemories } = makeRuntime(store);

    const cold = await search(runtime, "alexis gym");
    expect(getMemories).toHaveBeenCalledTimes(1);

    const warm = await search(runtime, "alexis gym");
    expect(getMemories).toHaveBeenCalledTimes(1); // corpus reused
    expect(warm).toEqual(cold);

    // Cold path after explicit invalidation must produce the exact same
    // ranking (cache is a pure perf optimization, not a semantic change).
    invalidateMemorySearchCache();
    const rebuilt = await search(runtime, "alexis gym");
    expect(getMemories).toHaveBeenCalledTimes(2);
    expect(rebuilt).toEqual(cold);
  });

  test("remember invalidates: new note is searchable immediately", async () => {
    const store: Store = {
      rows: [
        note("aaaaaaaa-0000-4000-8000-000000000001", "old note about tea", 1),
      ],
    };
    const { runtime } = makeRuntime(store);

    await search(runtime, "quartz"); // prime the cache

    const response: { value?: unknown } = {};
    await handleMemoryRoutes(
      contextFor({
        runtime,
        method: "POST",
        path: "/api/memory/remember",
        body: { text: "the quartz deadline moved to friday" },
        response,
      }),
    );
    expect(response.value).toEqual(expect.objectContaining({ ok: true }));

    const results = await search(runtime, "quartz");
    expect(results.some((r) => r.text.includes("quartz deadline"))).toBe(true);
  });

  test("DELETE invalidates: removed note stops appearing immediately", async () => {
    const target = "aaaaaaaa-0000-4000-8000-000000000009";
    const store: Store = {
      rows: [
        note(target, "obsolete plan about zeppelin logistics", 2),
        note("aaaaaaaa-0000-4000-8000-000000000002", "unrelated note", 1),
      ],
    };
    const { runtime } = makeRuntime(store);

    const before = await search(runtime, "zeppelin");
    expect(before.some((r) => r.id === target)).toBe(true);

    const response: { value?: unknown } = {};
    await handleMemoryRoutes(
      contextFor({
        runtime,
        method: "DELETE",
        path: `/api/memories/${target}`,
        response,
      }),
    );
    expect(response.value).toEqual(expect.objectContaining({ deleted: true }));

    const after = await search(runtime, "zeppelin");
    expect(after.some((r) => r.id === target)).toBe(false);
  });

  test("PATCH invalidates: edited text is searchable immediately", async () => {
    const target = "aaaaaaaa-0000-4000-8000-000000000005";
    const store: Store = {
      rows: [note(target, "original wording", 1)],
    };
    const { runtime } = makeRuntime(store);

    await search(runtime, "gyroscope"); // prime the cache with the old text

    const response: { value?: unknown } = {};
    await handleMemoryRoutes(
      contextFor({
        runtime,
        method: "PATCH",
        path: `/api/memories/${target}`,
        body: { text: "corrected wording about the gyroscope" },
        response,
      }),
    );
    expect(response.value).toEqual(expect.objectContaining({ updated: true }));

    const results = await search(runtime, "gyroscope");
    expect(results.some((r) => r.id === target)).toBe(true);
  });

  test("does not return a cached snapshot invalidated while COUNT is pending", async () => {
    const target = "aaaaaaaa-0000-4000-8000-000000000005";
    const store: Store = { rows: [note(target, "original wording", 1)] };
    const { runtime, getMemories, countMemories } = makeRuntime(store);
    await search(runtime, "gyroscope");

    let releaseCount = () => {};
    const countGate = new Promise<void>((resolve) => {
      releaseCount = resolve;
    });
    countMemories.mockImplementationOnce(async () => {
      await countGate;
      return store.rows.length;
    });
    const pendingSearch = search(runtime, "gyroscope");
    await vi.waitFor(() => expect(countMemories).toHaveBeenCalledTimes(3));

    const response: { value?: unknown } = {};
    await handleMemoryRoutes(
      contextFor({
        runtime,
        method: "PATCH",
        path: `/api/memories/${target}`,
        body: { text: "corrected wording about the gyroscope" },
        response,
      }),
    );
    releaseCount();

    await expect(pendingSearch).resolves.toEqual([
      expect.objectContaining({
        text: "corrected wording about the gyroscope",
      }),
    ]);
    expect(getMemories).toHaveBeenCalledTimes(2);
  });

  test("out-of-band create (row count change) is picked up on the next search", async () => {
    const store: Store = {
      rows: [note("aaaaaaaa-0000-4000-8000-000000000001", "baseline note", 1)],
    };
    const { runtime, getMemories } = makeRuntime(store);

    await search(runtime, "meteor");
    expect(getMemories).toHaveBeenCalledTimes(1);

    // Simulate a write that did NOT go through this module (normal chat
    // writing to the "messages" table).
    store.rows.push(
      note("aaaaaaaa-0000-4000-8000-000000000002", "meteor shower friday", 2),
    );

    const results = await search(runtime, "meteor");
    expect(getMemories).toHaveBeenCalledTimes(2); // count mismatch forced rebuild
    expect(results.some((r) => r.text.includes("meteor shower"))).toBe(true);
  });

  test("count mismatch supersedes an older in-flight background refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T00:00:00Z"));
    const store: Store = {
      rows: [note("aaaaaaaa-0000-4000-8000-000000000001", "baseline note", 1)],
    };
    const { runtime, getMemories } = makeRuntime(store);
    await search(runtime, "meteor");

    let releaseStaleScan = () => {};
    const staleScanGate = new Promise<void>((resolve) => {
      releaseStaleScan = resolve;
    });
    getMemories.mockImplementationOnce(async () => {
      const staleSnapshot = [...store.rows];
      await staleScanGate;
      return staleSnapshot;
    });

    // Start a stale-while-revalidate build and leave its old snapshot in flight.
    vi.advanceTimersByTime(11_000);
    await search(runtime, "meteor");
    await vi.waitFor(() => expect(getMemories).toHaveBeenCalledTimes(2));

    // The next request observes the changed count. It must start a new scan,
    // not join the older refresh that captured the one-row corpus.
    store.rows.push(
      note("aaaaaaaa-0000-4000-8000-000000000002", "meteor shower friday", 2),
    );
    const freshSearch = search(runtime, "meteor");
    await vi.waitFor(() => expect(getMemories).toHaveBeenCalledTimes(3));
    await expect(freshSearch).resolves.toEqual([
      expect.objectContaining({ text: "meteor shower friday" }),
    ]);

    releaseStaleScan();
  });

  test("count-preserving edit refreshes after one bounded stale response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T00:00:00Z"));
    const target = "aaaaaaaa-0000-4000-8000-000000000001";
    const store: Store = { rows: [note(target, "stale text", 1)] };
    const { runtime } = makeRuntime(store);

    await search(runtime, "kestrel");

    // In-place edit that keeps the row count identical.
    const row = store.rows.find((r) => r.id === target);
    if (row)
      row.content = { text: "kestrel sighting", source: HASH_MEMORY_SOURCE };

    // The first request after the TTL remains warm and launches one refresh.
    vi.advanceTimersByTime(16_000);
    const staleWhileRefreshing = await search(runtime, "kestrel");
    expect(staleWhileRefreshing).toEqual([]);
    for (let index = 0; index < 10; index++) await Promise.resolve();

    const results = await search(runtime, "kestrel");
    expect(results.some((r) => r.text === "kestrel sighting")).toBe(true);
  });

  test("persistent refresh failure cannot extend staleness past the hard bound", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T00:00:00Z"));
    const store: Store = {
      rows: [note("aaaaaaaa-0000-4000-8000-000000000001", "old osprey", 1)],
    };
    const { runtime, getMemories } = makeRuntime(store);
    await search(runtime, "osprey");
    const row = store.rows[0];
    if (row)
      row.content = {
        text: "replacement condor",
        source: HASH_MEMORY_SOURCE,
      };
    getMemories.mockRejectedValue(new Error("refresh backend unavailable"));

    vi.advanceTimersByTime(11_000);
    const boundedStale = await search(runtime, "osprey");
    expect(boundedStale).toHaveLength(1);
    for (let index = 0; index < 10; index++) await Promise.resolve();

    vi.advanceTimersByTime(10_000);
    await expect(search(runtime, "osprey")).rejects.toThrow(
      "refresh backend unavailable",
    );
    expect(runtime.reportError).toHaveBeenCalledWith(
      "MemorySearchCache.refresh",
      expect.objectContaining({ message: "refresh backend unavailable" }),
      expect.objectContaining({ roomId: expect.any(String) }),
    );
  });

  test("runtime without countMemories degrades to the uncached scan", async () => {
    const store: Store = {
      rows: [
        note("aaaaaaaa-0000-4000-8000-000000000001", "fallback path note", 1),
      ],
    };
    const { runtime, getMemories } = makeRuntime(store);
    (runtime as unknown as Record<string, unknown>).countMemories = undefined;

    const first = await search(runtime, "fallback");
    const second = await search(runtime, "fallback");
    expect(getMemories).toHaveBeenCalledTimes(2); // no cache without a freshness signal
    expect(second).toEqual(first);
  });

  test("isolates equal-count corpora owned by distinct runtime instances", async () => {
    const firstStore: Store = {
      rows: [
        note(
          "aaaaaaaa-0000-4000-8000-000000000001",
          "first runtime albatross",
          1,
        ),
      ],
    };
    const secondStore: Store = {
      rows: [
        note(
          "aaaaaaaa-0000-4000-8000-000000000002",
          "second runtime kestrel",
          1,
        ),
      ],
    };
    const first = makeRuntime(firstStore);
    const second = makeRuntime(secondStore);

    expect(await search(first.runtime, "albatross")).toHaveLength(1);
    const secondResults = await search(second.runtime, "kestrel");

    expect(secondResults.map((result) => result.text)).toEqual([
      "second runtime kestrel",
    ]);
    expect(second.getMemories).toHaveBeenCalledOnce();
  });

  test("does not publish a corpus whose scan raced a row-count change", async () => {
    const store: Store = {
      rows: [
        note("aaaaaaaa-0000-4000-8000-000000000001", "baseline sparrow", 1),
      ],
    };
    const { runtime, getMemories } = makeRuntime(store);
    getMemories.mockImplementationOnce(async () => {
      const staleSnapshot = [...store.rows];
      store.rows.push(
        note("aaaaaaaa-0000-4000-8000-000000000002", "racing pelican", 2),
      );
      return staleSnapshot;
    });

    expect(await search(runtime, "pelican")).toEqual([]);
    const fresh = await search(runtime, "pelican");

    expect(getMemories).toHaveBeenCalledTimes(2);
    expect(fresh.map((result) => result.text)).toEqual(["racing pelican"]);
  });

  test("single-flights concurrent cold rebuilds for one runtime and room", async () => {
    const store: Store = {
      rows: [
        note(
          "aaaaaaaa-0000-4000-8000-000000000001",
          "shared rebuild puffin",
          1,
        ),
      ],
    };
    const { runtime, getMemories } = makeRuntime(store);
    let releaseScan = () => {};
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    getMemories.mockImplementationOnce(async () => {
      await scanGate;
      return [...store.rows];
    });

    const first = search(runtime, "puffin");
    const second = search(runtime, "puffin");
    await vi.waitFor(() => expect(getMemories).toHaveBeenCalledOnce());
    releaseScan();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.any(Array),
      expect.any(Array),
    ]);
    expect(getMemories).toHaveBeenCalledOnce();
  });

  test("reports count failures and keeps the fallback corpus uncached", async () => {
    const store: Store = {
      rows: [
        note("aaaaaaaa-0000-4000-8000-000000000001", "fallback count heron", 1),
      ],
    };
    const { runtime, getMemories, countMemories } = makeRuntime(store);
    countMemories.mockRejectedValue(new Error("count backend unavailable"));

    await search(runtime, "heron");
    await search(runtime, "heron");

    expect(getMemories).toHaveBeenCalledTimes(2);
    expect(runtime.reportError).toHaveBeenCalledWith(
      "MemorySearchCache.countRoomMessages",
      expect.objectContaining({ message: "count backend unavailable" }),
      expect.objectContaining({ roomId: expect.any(String) }),
    );
  });

  test("does not retain a corpus whose source text exceeds the byte budget", async () => {
    const rows = Array.from({ length: 2_000 }, (_, index) =>
      note(
        `aaaaaaaa-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        `oversized-${index}-${"x".repeat(4_200)}`,
        index,
      ),
    );
    const { runtime, getMemories } = makeRuntime({ rows });

    await search(runtime, "term-not-present");
    await search(runtime, "term-not-present");

    expect(getMemories).toHaveBeenCalledTimes(2);
  });
});
