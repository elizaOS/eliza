/**
 * Exercises memory viewer pagination at the real route boundary with a
 * deterministic adapter-shaped store. The harness honors database predicates,
 * offsets, and limits so sparse post-filters and multi-table ordering are
 * verified without replacing the route logic under test.
 */

import {
  type AgentRuntime,
  compareMemoryIds,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { describe, expect, test, vi } from "vitest";
import type { MemoryRouteContext } from "./memory-routes.ts";
import { handleMemoryRoutes } from "./memory-routes.ts";

const AGENT_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const ENTITY = "22222222-2222-4222-8222-222222222222" as UUID;
const OTHER = "33333333-3333-4333-8333-333333333333" as UUID;
const ROOM = "44444444-4444-4444-8444-444444444444" as UUID;

function makeRow(
  i: number,
  text: string,
  entityId: UUID = OTHER,
  createdAt = 2_000_000 - i,
): Memory {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` as UUID,
    entityId,
    roomId: ROOM,
    agentId: AGENT_ID,
    createdAt,
    content: { text },
  } as Memory;
}

type MemoryQuery = {
  tableName: string;
  limit: number;
  offset?: number;
  cursor?: { createdAt: number; id: UUID };
  roomId?: UUID;
  end?: number;
  textContains?: string;
};

function makeRuntime(tables: Record<string, Memory[]>): {
  runtime: AgentRuntime;
  getMemories: ReturnType<typeof vi.fn>;
} {
  const getMemories = vi.fn(async (query: MemoryQuery) => {
    let rows = tables[query.tableName] ?? [];
    if (query.roomId) rows = rows.filter((row) => row.roomId === query.roomId);
    if (query.end !== undefined) {
      const end = query.end;
      rows = rows.filter((row) => (row.createdAt ?? 0) <= end);
    }
    if (query.textContains) {
      const needle = query.textContains.toLowerCase();
      rows = rows.filter((row) =>
        ((row.content as { text?: string }).text ?? "")
          .toLowerCase()
          .includes(needle),
      );
    }
    rows = rows.slice().sort((a, b) => {
      const timeOrder = (b.createdAt ?? 0) - (a.createdAt ?? 0);
      return timeOrder !== 0
        ? timeOrder
        : compareMemoryIds(b.id ?? "", a.id ?? "");
    });
    if (query.cursor) {
      const cursor = query.cursor;
      rows = rows.filter((row) => {
        const createdAt = row.createdAt ?? 0;
        return (
          createdAt < cursor.createdAt ||
          (createdAt === cursor.createdAt &&
            compareMemoryIds(row.id ?? "", cursor.id) < 0)
        );
      });
    }
    return rows
      .slice(query.offset ?? 0, (query.offset ?? 0) + query.limit)
      .map((row) => ({ ...row }));
  });
  return {
    runtime: {
      agentId: AGENT_ID,
      character: { name: "Eliza" },
      ensureConnection: vi.fn(async () => undefined),
      getMemories,
    } as unknown as AgentRuntime,
    getMemories,
  };
}

async function get(
  runtime: AgentRuntime,
  path: string,
): Promise<Record<string, unknown>> {
  const url = new URL(`https://agent.test${path}`);
  let output: unknown;
  const context: MemoryRouteContext = {
    req: {} as never,
    res: {} as never,
    method: "GET",
    pathname: url.pathname,
    url,
    runtime,
    agentName: "Eliza",
    json: (_res, value) => {
      output = value;
    },
    error: (_res, message, status) => {
      throw new Error(`unexpected ${status}: ${message}`);
    },
    readJsonBody: async <T extends object>() => ({}) as T,
  };
  expect(await handleMemoryRoutes(context)).toBe(true);
  return output as Record<string, unknown>;
}

const ids = (response: Record<string, unknown>): string[] =>
  (response.memories as Array<{ id: string }>).map((memory) => memory.id);

function buildSparseRows(): Memory[] {
  return Array.from({ length: 1_000 }, (_, i) =>
    makeRow(
      i,
      i % 10 === 0 ? `needle row ${i}` : `hay row ${i}`,
      i % 20 === 0 ? ENTITY : OTHER,
    ),
  );
}

describe("memory viewer incremental pagination (#22061)", () => {
  test("reaches every sparse OR-query match through bounded pages", async () => {
    const { runtime, getMemories } = makeRuntime({
      messages: buildSparseRows(),
    });
    const seen = new Set<string>();
    let offset = 0;
    let finalTotal = 0;

    for (;;) {
      const firstCall = getMemories.mock.calls.length;
      const page = await get(
        runtime,
        `/api/memories/browse?type=messages&q=needle%20missing&limit=25&offset=${offset}`,
      );
      const pageCalls = getMemories.mock.calls
        .slice(firstCall)
        .map(([query]) => query as MemoryQuery);
      expect(pageCalls[0]?.cursor).toBeUndefined();
      for (let i = 1; i < pageCalls.length; i++) {
        expect(pageCalls[i]?.cursor).toBeDefined();
        expect(pageCalls[i]?.offset).toBeUndefined();
      }
      for (const id of ids(page)) seen.add(id);
      finalTotal = page.total as number;
      expect(page.totalIsExact).toBe(false);
      if (page.hasMore === false) break;
      offset += 25;
    }

    expect(seen.size).toBe(100);
    expect(finalTotal).toBe(100);
    expect(
      getMemories.mock.calls.every(
        ([query]) => (query as MemoryQuery).textContains === undefined,
      ),
    ).toBe(true);
  });

  test("pushes a single keyword into the adapter and labels totals incomplete", async () => {
    const { runtime, getMemories } = makeRuntime({
      messages: buildSparseRows(),
    });
    const page = await get(
      runtime,
      "/api/memories/browse?type=messages&q=needle&limit=50",
    );
    expect(ids(page)).toHaveLength(50);
    expect(page.total).toBe(100);
    expect(page).toMatchObject({ totalIsExact: false, hasMore: true });
    expect(getMemories).toHaveBeenCalledTimes(1);
    const firstQuery = getMemories.mock.calls[0]?.[0] as
      | MemoryQuery
      | undefined;
    expect(firstQuery?.textContains).toBe("needle");
  });

  test("returns all sparsely represented entity rows after true exhaustion", async () => {
    const { runtime } = makeRuntime({ messages: buildSparseRows() });
    const response = await get(
      runtime,
      `/api/memories/by-entity/${ENTITY}?type=messages&limit=50`,
    );
    expect(ids(response)).toHaveLength(50);
    expect(response.total).toBe(50);
    expect(response).toMatchObject({ totalIsExact: false, hasMore: false });
  });

  test("finds older feed rows beyond a long empty-content run", async () => {
    const rows = Array.from({ length: 1_000 }, (_, i) =>
      makeRow(i, i < 30 || i >= 900 ? `text ${i}` : ""),
    );
    const { runtime } = makeRuntime({ messages: rows });
    const response = await get(
      runtime,
      "/api/memories/feed?type=messages&limit=50",
    );
    expect(response).toMatchObject({ count: 50, hasMore: true });
  });

  test("terminates after one request when a table is truly exhausted", async () => {
    const { runtime, getMemories } = makeRuntime({
      messages: [makeRow(0, "needle"), makeRow(1, "hay")],
    });
    const response = await get(
      runtime,
      "/api/memories/browse?type=messages&q=needle%20missing&limit=50",
    );
    expect(response.total).toBe(1);
    expect(response).toMatchObject({ totalIsExact: false, hasMore: false });
    expect(getMemories).toHaveBeenCalledTimes(1);
  });

  test("serves an unfiltered page beyond the rejected fixed scan cap", async () => {
    const rows = Array.from({ length: 20_120 }, (_, i) =>
      makeRow(i, `row ${i}`),
    );
    const { runtime, getMemories } = makeRuntime({ messages: rows });
    const response = await get(
      runtime,
      "/api/memories/browse?type=messages&limit=20&offset=20000",
    );
    expect(ids(response)).toHaveLength(20);
    expect(response.total).toBe(20_120);

    const calls = getMemories.mock.calls.map(([query]) => query as MemoryQuery);
    expect(calls[0]?.cursor).toBeUndefined();
    expect(calls.slice(1).every((query) => query.cursor !== undefined)).toBe(
      true,
    );
    expect(calls.reduce((sum, query) => sum + query.limit, 0)).toBeLessThan(
      26_000,
    );
  });

  test("reads only enough from every table for a correct global page", async () => {
    const messages = Array.from({ length: 800 }, (_, i) =>
      makeRow(i, `message ${i}`, OTHER, 3_000_000 - i * 2),
    );
    const facts = Array.from({ length: 800 }, (_, i) =>
      makeRow(10_000 + i, `fact ${i}`, OTHER, 2_999_999 - i * 2),
    );
    const { runtime } = makeRuntime({ messages, facts });
    const response = await get(
      runtime,
      "/api/memories/browse?limit=20&offset=250",
    );
    expect(ids(response)).toHaveLength(20);
    expect(response).toMatchObject({
      total: 1_200,
      totalIsExact: false,
      hasMore: true,
    });

    const expected = [...messages, ...facts]
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(250, 270)
      .map((row) => row.id);
    expect(ids(response)).toEqual(expected);
  });

  test("does not duplicate or skip rows when earlier rows mutate between windows", async () => {
    const rows = Array.from({ length: 650 }, (_, i) =>
      makeRow(i, i % 10 === 0 ? `needle ${i}` : `hay ${i}`),
    );
    const { runtime, getMemories } = makeRuntime({ messages: rows });
    getMemories.mockImplementationOnce(async (query: MemoryQuery) => {
      const first = rows.slice(0, query.limit).map((row) => ({ ...row }));
      rows.unshift(makeRow(9_000, "newer insertion", OTHER, 3_000_000));
      rows.splice(20, 1);
      rows.splice(40, 1);
      return first;
    });

    const response = await get(
      runtime,
      "/api/memories/browse?type=messages&q=needle%20missing&limit=50",
    );
    const resultIds = ids(response);
    expect(resultIds).toHaveLength(50);
    expect(new Set(resultIds).size).toBe(50);
    expect(resultIds).not.toContain(makeRow(9_000, "").id);
    expect(resultIds).toEqual(
      Array.from({ length: 50 }, (_, index) => makeRow(index * 10, "").id),
    );
    expect(
      getMemories.mock.calls.slice(1).every(([query]) => {
        const typed = query as MemoryQuery;
        return typed.cursor !== undefined && typed.offset === undefined;
      }),
    ).toBe(true);
  });

  test("fails closed when an adapter accepts but ignores the keyset cursor", async () => {
    const rows = Array.from({ length: 450 }, (_, i) =>
      makeRow(i, i >= 420 ? `needle ${i}` : `hay ${i}`),
    );
    const { runtime, getMemories } = makeRuntime({ messages: rows });
    const cursorAware = getMemories.getMockImplementation() as
      | ((query: MemoryQuery) => Promise<Memory[]>)
      | undefined;
    expect(cursorAware).toBeDefined();
    getMemories.mockImplementation((query: MemoryQuery) =>
      cursorAware?.({ ...query, cursor: undefined }),
    );

    await expect(
      get(
        runtime,
        "/api/memories/browse?type=messages&q=needle%20missing&limit=20",
      ),
    ).rejects.toMatchObject({ code: "MEMORY_BROWSE_CURSOR_NO_PROGRESS" });
    expect(getMemories).toHaveBeenCalledTimes(2);
  });

  test("fails closed at a request-wide sparse scan bound", async () => {
    const rows = Array.from({ length: 25_001 }, (_, i) =>
      makeRow(i, `hay ${i}`),
    );
    const { runtime, getMemories } = makeRuntime({ messages: rows });

    await expect(
      get(
        runtime,
        "/api/memories/browse?type=messages&q=needle%20missing&limit=20",
      ),
    ).rejects.toMatchObject({ code: "MEMORY_BROWSE_SCAN_LIMIT" });
    expect(
      getMemories.mock.calls.reduce(
        (sum, [query]) => sum + (query as MemoryQuery).limit,
        0,
      ),
    ).toBe(25_000);
  });
});
