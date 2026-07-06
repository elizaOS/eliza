/**
 * End-to-end proof that the backdated message-corpus seeder feeds real, scalable
 * time-window message search. Runs the REAL `generateMessageCorpus` +
 * `seedMessageCorpus` and drives the REAL `InMemoryDatabaseAdapter.searchMessages`
 * (real `rankMessageSearch` + real `withinCreatedAtWindow`) — no model of the
 * store stands in for the thing under test.
 *
 * The adapter is imported from the in-tree core source (relative path) rather
 * than the `@elizaos/core` dist so the window filter under test is the current
 * source, not a stale build in a shared worktree tree. The seeder writes through
 * a thin runtime shim whose `createMemory`/`ensureConnection` delegate straight
 * to that real adapter, so the seed → store → search path is fully real.
 *
 * It locks the properties the lane exists to guarantee:
 *   1. Corpus-wide recall — a keyword from ~a year ago is found even when a
 *      recency window would otherwise truncate it.
 *   2. `since`/`until` narrow correctly and never leak a row outside the window.
 *   3. Pagination is stable — disjoint offset pages tile the full result set.
 */

import type { Memory, MessageSearchHit, UUID } from "@elizaos/core";
import { beforeAll, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../../core/src/database/inMemoryAdapter.ts";
import {
  generateMessageCorpus,
  type MessageCorpusRuntime,
  seedMessageCorpus,
} from "../message-corpus.ts";

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
// Frozen anchor so backdated timestamps + spread are byte-stable across runs.
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const SEED = 4242;
const AGENT_ID = "00000000-0000-0000-0000-0000000000a9" as UUID;

/**
 * Real runtime surface for the seeder: `createMemory` lands rows in the real
 * adapter under the given table; `ensureConnection` records the room. Both are
 * genuine adapter writes — the search path they feed is unmocked.
 */
function makeRuntimeShim(
  adapter: InMemoryDatabaseAdapter,
): MessageCorpusRuntime {
  return {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    async ensureConnection(params) {
      await adapter.createRooms([
        {
          id: params.roomId,
          agentId: AGENT_ID,
          name: params.roomName,
          source: params.source ?? "test",
          type: "dm",
          worldId: params.worldId,
          channelId: params.channelId,
        } as Parameters<InMemoryDatabaseAdapter["createRooms"]>[0][number],
      ]);
    },
    async createMemory(memory: Memory, tableName: string, unique?: boolean) {
      const [id] = await adapter.createMemories([
        { memory, tableName, ...(unique !== undefined ? { unique } : {}) },
      ]);
      return id;
    },
  };
}

async function search(
  adapter: InMemoryDatabaseAdapter,
  roomIds: readonly UUID[],
  query: string,
  opts: {
    limit?: number;
    offset?: number;
    since?: number;
    until?: number;
  } = {},
): Promise<MessageSearchHit[]> {
  return adapter.searchMessages({
    roomIds: [...roomIds],
    query,
    tableName: "messages",
    limit: opts.limit ?? 20,
    offset: opts.offset ?? 0,
    ...(opts.since !== undefined ? { since: opts.since } : {}),
    ...(opts.until !== undefined ? { until: opts.until } : {}),
  });
}

const at = (h: MessageSearchHit): number =>
  typeof h.memory.createdAt === "number" ? h.memory.createdAt : Number.NaN;

describe("message-corpus seeder → real time-window search", () => {
  let adapter: InMemoryDatabaseAdapter;
  let roomIds: UUID[];
  let sampleQueries: string[];
  let oldestMessageAt: number;
  let newestMessageAt: number;

  beforeAll(async () => {
    adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
    // ~1 year+ of history: 10 conversations × 30 messages over 13 months, so
    // there is material on both sides of every "N months ago" boundary.
    const corpus = generateMessageCorpus({
      conversationCount: 10,
      messagesPerConversation: 30,
      spanMonths: 13,
      factsPerConversation: 1,
      seed: SEED,
      now: NOW,
    });
    const summary = await seedMessageCorpus(makeRuntimeShim(adapter), corpus);
    roomIds = summary.conversations.map((c) => c.roomId);
    sampleQueries = summary.sampleQueries;
    oldestMessageAt = summary.oldestMessageAt;
    newestMessageAt = summary.newestMessageAt;
  });

  it("seeds a real backdated corpus spanning more than a year", () => {
    expect(roomIds.length).toBe(10);
    expect(NOW - oldestMessageAt).toBeGreaterThan(YEAR_MS);
    expect(newestMessageAt).toBeLessThanOrEqual(NOW);
    expect(sampleQueries.length).toBeGreaterThan(0);
  });

  it("corpus-wide recall: search reaches back past a year for a real keyword", async () => {
    // Every sample query names a distinct topic pack; the oldest packs sit ~13
    // months back. Prove the search itself reaches a hit older than a one-year
    // boundary — a recency-truncated slice would drop it.
    const oldestAcrossQueries = Math.min(
      ...(await Promise.all(
        sampleQueries.map(async (q) => {
          const hits = await search(adapter, roomIds, q, { limit: 500 });
          expect(hits.length).toBeGreaterThan(0);
          return Math.min(...hits.map(at));
        }),
      )),
    );
    expect(NOW - oldestAcrossQueries).toBeGreaterThan(YEAR_MS);
  });

  it("until= narrows to older messages; every hit is within the window", async () => {
    const query = sampleQueries[0];
    const unbounded = await search(adapter, roomIds, query, { limit: 500 });
    const until = NOW - 9 * MONTH_MS;
    const windowed = await search(adapter, roomIds, query, {
      limit: 500,
      until,
    });
    // A window can only shrink or hold the result set, never grow it.
    expect(windowed.length).toBeLessThanOrEqual(unbounded.length);
    // No hit newer than `until` leaks through.
    expect(windowed.every((h) => at(h) <= until)).toBe(true);
    // The window is meaningful: there ARE newer hits it excluded.
    expect(unbounded.some((h) => at(h) > until)).toBe(true);
  });

  it("since= narrows to newer messages; every hit is within the window", async () => {
    const query = sampleQueries[0];
    const since = NOW - 4 * MONTH_MS;
    const windowed = await search(adapter, roomIds, query, {
      limit: 500,
      since,
    });
    expect(windowed.every((h) => at(h) >= since)).toBe(true);
    const unbounded = await search(adapter, roomIds, query, { limit: 500 });
    // Something older than `since` exists in the unbounded set that this dropped.
    expect(unbounded.some((h) => at(h) < since)).toBe(true);
  });

  it("since+until brackets an inner window derived from the real hit spread", async () => {
    // Pick a query whose hits span more than a day, then bracket strictly
    // inside the oldest and newest hit. The window must drop both extremes and
    // keep the interior — proving since AND until narrow at once, on real
    // backdated timestamps rather than an assumed month layout.
    let query = sampleQueries[0];
    let times = (await search(adapter, roomIds, query, { limit: 500 }))
      .map(at)
      .sort((a, b) => a - b);
    for (const q of sampleQueries) {
      const t = (await search(adapter, roomIds, q, { limit: 500 }))
        .map(at)
        .sort((a, b) => a - b);
      if (
        t.length >= 3 &&
        t[t.length - 1] - t[0] > times[times.length - 1] - times[0]
      ) {
        query = q;
        times = t;
      }
    }
    const oldest = times[0];
    const newest = times[times.length - 1];
    expect(newest - oldest).toBeGreaterThan(24 * 60 * 60 * 1000);
    const since = oldest + 1;
    const until = newest - 1;
    const windowed = await search(adapter, roomIds, query, {
      limit: 500,
      since,
      until,
    });
    expect(windowed.every((h) => at(h) >= since && at(h) <= until)).toBe(true);
    // Both extremes were excluded — narrowing happened on both bounds.
    expect(windowed.some((h) => at(h) === oldest)).toBe(false);
    expect(windowed.some((h) => at(h) === newest)).toBe(false);
    // And the interior survived: unless every hit sat on an extreme, some remain.
    const interior = times.filter((t) => t > oldest && t < newest);
    expect(windowed.length).toBe(interior.length);
  });

  it("pagination is stable: disjoint offset pages tile the full result set", async () => {
    const query = sampleQueries[0];
    const full = await search(adapter, roomIds, query, { limit: 500 });
    expect(full.length).toBeGreaterThan(6);

    const pageSize = 3;
    const pages: MessageSearchHit[][] = [];
    for (let offset = 0; offset < full.length; offset += pageSize) {
      pages.push(
        await search(adapter, roomIds, query, { limit: pageSize, offset }),
      );
    }
    const paged = pages.flat();

    // Same length, same order, same rows — offset paging reproduces the full
    // ranking with no gaps and no duplicates.
    expect(paged.map((h) => h.memory.id)).toEqual(full.map((h) => h.memory.id));
    expect(new Set(paged.map((h) => h.memory.id)).size).toBe(paged.length);
  });

  it("a window entirely after the corpus returns nothing (never a fabricated hit)", async () => {
    const query = sampleQueries[0];
    const since = NOW + 24 * 60 * 60 * 1000;
    const until = NOW + 2 * 24 * 60 * 60 * 1000;
    const windowed = await search(adapter, roomIds, query, {
      limit: 500,
      since,
      until,
    });
    expect(windowed.length).toBe(0);
  });
});
