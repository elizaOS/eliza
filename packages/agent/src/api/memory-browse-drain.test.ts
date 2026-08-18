/**
 * Exercises the filtered-browse drain loop at the real handleMemoryRoutes
 * boundary with a deterministic in-memory runtime that honors `limit` the way
 * a real adapter does (newest-first prefix). Covers the three over-fetch
 * defects from #22061: sparse keyword filters losing matches on deep pages,
 * by-entity post-filter truncation, and the feed's post-filter hasMore
 * false-negative — plus drain termination on true exhaustion and the
 * MEMORY_BROWSE_SCAN_CAP safety cap.
 */

import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, test, vi } from "vitest";
import type { MemoryRouteContext } from "./memory-routes.ts";
import { handleMemoryRoutes } from "./memory-routes.ts";

const AGENT_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const ENTITY = "22222222-2222-4222-8222-222222222222" as UUID;
const OTHER = "33333333-3333-4333-8333-333333333333" as UUID;
const ROOM = "44444444-4444-4444-8444-444444444444" as UUID;

function makeRow(i: number, text: string, entityId: UUID = OTHER): Memory {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` as UUID,
    entityId,
    roomId: ROOM,
    agentId: AGENT_ID,
    createdAt: 2_000_000 - i, // strictly newest-first
    content: { text },
  } as Memory;
}

/** 1000 messages: every 10th contains "needle" (100), every 20th owned by ENTITY (50). */
function buildDb(): Memory[] {
  const db: Memory[] = [];
  for (let i = 0; i < 1000; i++) {
    db.push(
      makeRow(
        i,
        i % 10 === 0 ? `needle row ${i}` : `hay row ${i}`,
        i % 20 === 0 ? ENTITY : OTHER,
      ),
    );
  }
  return db;
}

function makeRuntime(db: Memory[]): {
  runtime: AgentRuntime;
  getMemories: ReturnType<typeof vi.fn>;
} {
  const getMemories = vi.fn(
    async ({ tableName, limit }: { tableName: string; limit: number }) =>
      tableName === "messages" ? db.slice(0, limit).map((r) => ({ ...r })) : [],
  );
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    ensureConnection: vi.fn(async () => undefined),
    getMemories,
  } as unknown as AgentRuntime;
  return { runtime, getMemories };
}

async function get(
  runtime: AgentRuntime,
  path: string,
): Promise<Record<string, unknown>> {
  const url = new URL(`https://agent.test${path}`);
  let out: unknown;
  const context: MemoryRouteContext = {
    req: {} as never,
    res: {} as never,
    method: "GET",
    pathname: url.pathname,
    url,
    runtime,
    agentName: "Eliza",
    json: (_res, value) => {
      out = value;
    },
    error: (_res, message, status) => {
      throw new Error(`unexpected ${status}: ${message}`);
    },
    readJsonBody: async <T extends object>() => ({}) as T,
  };
  expect(await handleMemoryRoutes(context)).toBe(true);
  return out as Record<string, unknown>;
}

const ids = (res: Record<string, unknown>): string[] =>
  (res.memories as Array<{ id: string }>).map((m) => m.id);

describe("filtered browse drain (#22061)", () => {
  test("sparse q filter reaches every match across pages with a consistent final total", async () => {
    const { runtime } = makeRuntime(buildDb());
    const union = new Set<string>();
    let offset = 0;
    let lastTotal = 0;
    for (;;) {
      const page = await get(
        runtime,
        `/api/memories/browse?type=messages&q=needle&limit=50&offset=${offset}`,
      );
      const pageIds = ids(page);
      for (const id of pageIds) union.add(id);
      lastTotal = page.total as number;
      // Every page but the last must be full; total must never falsely
      // report exhaustion while more matches remain reachable.
      if (offset + 50 >= lastTotal) break;
      expect(pageIds).toHaveLength(50);
      offset += 50;
    }
    expect(union.size).toBe(100); // all 100 matching rows reachable
    expect(lastTotal).toBe(100); // exact once the drain exhausted the table
  });

  test("first page total is at least a full page beyond the window, never a lying exhaustion", async () => {
    const { runtime } = makeRuntime(buildDb());
    const p0 = await get(
      runtime,
      "/api/memories/browse?type=messages&q=needle&limit=50&offset=0",
    );
    expect(ids(p0)).toHaveLength(50);
    // total is either exact (100) or a lower bound > offset+limit so the
    // UI's Next control stays enabled.
    expect(p0.total as number).toBeGreaterThan(50);
  });

  test("by-entity returns all 50 rows for a sparsely represented entity", async () => {
    const { runtime } = makeRuntime(buildDb());
    const res = await get(
      runtime,
      `/api/memories/by-entity/${ENTITY}?type=messages&limit=50&offset=0`,
    );
    expect(ids(res)).toHaveLength(50);
    expect(res.total).toBe(50);
    expect(
      (res.memories as Array<{ entityId: string }>).every(
        (m) => m.entityId === ENTITY,
      ),
    ).toBe(true);
  });

  test("feed hasMore is true when later browsable rows exist past an empty-text run", async () => {
    // Newest 30 rows with text, next 870 empty, oldest 100 with text:
    // 130 browsable rows total, so a limit-50 feed has more.
    const db: Memory[] = [];
    for (let i = 0; i < 1000; i++) {
      db.push(makeRow(i, i < 30 || i >= 900 ? `txt ${i}` : ""));
    }
    const { runtime } = makeRuntime(db);
    const res = await get(runtime, "/api/memories/feed?type=messages&limit=50");
    expect(res.count).toBe(50);
    expect(res.hasMore).toBe(true);
  });

  test("true exhaustion (adapter returns fewer rows than requested) terminates the drain", async () => {
    const db = [makeRow(0, "needle"), makeRow(1, "hay"), makeRow(2, "needle")];
    const { runtime, getMemories } = makeRuntime(db);
    const res = await get(
      runtime,
      "/api/memories/browse?type=messages&q=needle&limit=50&offset=0",
    );
    expect(ids(res)).toHaveLength(2);
    expect(res.total).toBe(2); // exact — the whole table was scanned
    expect(getMemories).toHaveBeenCalledTimes(1); // no futile refetch rounds
  });

  test("safety cap bounds the scan when nothing ever matches an endless table", async () => {
    // Adapter always returns exactly `limit` rows (looks bottomless) and no
    // row ever matches — without the cap the drain would double forever.
    const requestedLimits: number[] = [];
    const getMemories = vi.fn(
      async ({ limit }: { tableName: string; limit: number }) => {
        requestedLimits.push(limit);
        return Array.from({ length: limit }, (_, i) => ({
          ...makeRow(i, `hay ${i}`),
        }));
      },
    );
    const runtime = {
      agentId: AGENT_ID,
      character: { name: "Eliza" },
      ensureConnection: vi.fn(async () => undefined),
      getMemories,
    } as unknown as AgentRuntime;
    const res = await get(
      runtime,
      "/api/memories/browse?type=messages&q=absent-needle&limit=50&offset=0",
    );
    expect(ids(res)).toHaveLength(0);
    expect(res.total).toBe(0);
    // The per-table window is clamped to MEMORY_BROWSE_SCAN_CAP (10k rows).
    expect(Math.max(...requestedLimits)).toBeLessThanOrEqual(10_000);
    expect(getMemories.mock.calls.length).toBeLessThan(12);
  });
});
