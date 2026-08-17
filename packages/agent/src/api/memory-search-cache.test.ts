/**
 * Regression coverage for the /api/memory/search corpus + BM25 cache:
 * identical ranking cached vs cold, explicit invalidation on module-local
 * mutations (remember / DELETE / PATCH), count-based staleness detection for
 * out-of-band writes, and the TTL bound for count-preserving edits.
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

  test("count-preserving out-of-band edit is served fresh after the TTL", async () => {
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

    // Within the TTL the cached corpus may be served (bounded staleness).
    vi.advanceTimersByTime(1_000);
    // After the TTL the rebuild must observe the edit.
    vi.advanceTimersByTime(15_000);
    const results = await search(runtime, "kestrel");
    expect(results.some((r) => r.text === "kestrel sighting")).toBe(true);
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
});
