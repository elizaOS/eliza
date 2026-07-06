/**
 * Endpoint test for `GET /api/conversations/messages/search` — the corpus-wide
 * message search (#13534, follow-up #9955). Drives the real
 * `handleConversationRoutes` and asserts the HTTP-boundary behaviour the route
 * owns: access-scoping across rooms, DTO shape, role attribution, snippeting,
 * deleted-message and deleted-conversation exclusion, corpus-wide (not recency-
 * truncated) ordering, and empty/edge input.
 *
 * The unit under test is the route handler; `runtime.searchMessages` is a
 * collaborator whose REAL implementation is proven against a live PGlite store
 * in `plugins/plugin-sql/.../message-search-fts.test.ts` (18 edge cases) and
 * `packages/benchmarks/searchbench` (10k corpus). Here it is backed by a
 * faithful in-test model of that contract — fold the query, keep a row when
 * every query term is present or the whole folded query is a substring, rank
 * corpus-wide by match count then recency, then window — so the handler runs
 * against realistic ranked input without pinning the agent test to the store's
 * cross-package module resolution.
 */

import { randomUUID } from "node:crypto";
import type {
  AgentRuntime,
  Memory,
  MessageSearchHit,
  UUID,
} from "@elizaos/core";
import { MemoryType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  type ConversationRouteContext,
  type ConversationRouteState,
  handleConversationRoutes,
} from "../conversation-routes.ts";
import type { ConversationMeta } from "../server-types.ts";

const agentId = randomUUID() as UUID;
const userId = randomUUID() as UUID;
const roomA = randomUUID() as UUID;
const roomB = randomUUID() as UUID;
const roomDeletedConv = randomUUID() as UUID;

interface SeedRow {
  id: UUID;
  roomId: UUID;
  text: string;
  author: "user" | "assistant";
  attachments?: Array<{ title?: string; url?: string }>;
  createdAt: number;
}

/** Mirrors `foldForSearch` in @elizaos/core: NFKD, strip accents/apostrophes, lowercase. */
function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’`]/g, "")
    .normalize("NFC")
    .toLowerCase();
}

function docOf(row: SeedRow): string {
  const parts = [row.text];
  for (const a of row.attachments ?? []) {
    if (a.title) parts.push(a.title);
    if (a.url) parts.push(a.url);
  }
  return fold(parts.join(" "));
}

/** Faithful model of IDatabaseAdapter.searchMessages: corpus-wide ranked hits. */
function modelSearch(
  rows: SeedRow[],
  params: {
    roomIds: UUID[];
    query: string;
    limit?: number;
    offset?: number;
    since?: number;
    until?: number;
  },
): MessageSearchHit[] {
  const roomSet = new Set(params.roomIds);
  const q = fold(params.query).trim();
  const terms = q.split(/\s+/).filter(Boolean);
  const hits = rows
    .filter((r) => roomSet.has(r.roomId))
    // Inclusive [since, until] window, applied before ranking + LIMIT/OFFSET,
    // exactly as the real adapters do.
    .filter(
      (r) =>
        (params.since === undefined || r.createdAt >= params.since) &&
        (params.until === undefined || r.createdAt <= params.until),
    )
    .map((r) => {
      const doc = docOf(r);
      const allTerms = terms.every((t) => doc.includes(t));
      const phrase = doc.includes(q);
      if (!allTerms && !phrase) return null;
      const ftsRank = terms.reduce(
        (acc, t) => acc + (doc.split(t).length - 1) / Math.max(doc.length, 1),
        0,
      );
      return { row: r, ftsRank };
    })
    .filter((h): h is { row: SeedRow; ftsRank: number } => h !== null)
    .sort((a, b) =>
      b.ftsRank !== a.ftsRank
        ? b.ftsRank - a.ftsRank
        : b.row.createdAt !== a.row.createdAt
          ? b.row.createdAt - a.row.createdAt
          : a.row.id.localeCompare(b.row.id),
    );
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 20;
  return hits.slice(offset, offset + limit).map(({ row, ftsRank }) => ({
    memory: {
      id: row.id,
      entityId: row.author === "assistant" ? agentId : userId,
      agentId,
      roomId: row.roomId,
      content: {
        text: row.text,
        ...(row.attachments ? { attachments: row.attachments } : {}),
      },
      createdAt: row.createdAt,
      metadata: { type: MemoryType.MESSAGE },
    } as Memory,
    ftsRank,
    trigramSimilarity: 0,
  }));
}

let seq = 0;
const rows: SeedRow[] = [];
function seed(
  roomId: UUID,
  text: string,
  author: "user" | "assistant",
  attachments?: Array<{ title?: string; url?: string }>,
): UUID {
  const id = randomUUID() as UUID;
  rows.push({
    id,
    roomId,
    text,
    author,
    attachments,
    createdAt: 1_000 + seq++,
  });
  return id;
}

seed(roomA, "deploy your first agent to the cloud", "user");
seed(roomA, "I opened a PR on GitHub this morning", "assistant");
seed(roomA, "the café down the street has great coffee", "user");
seed(roomA, "please don't merge that branch yet", "assistant");
seed(roomA, "how do I edit the configuration file", "user");
seed(roomA, "I am configuring the webhook right now", "assistant");
seed(roomA, "run `SELECT * FROM t WHERE name LIKE '%bob_%'` now", "user");
seed(
  roomA,
  "see https://example.com/docs/path/to/thing for details",
  "assistant",
);
seed(roomA, "great work 🚀 shipping today", "user");
seed(roomA, "北京 is the capital of China", "assistant");
seed(roomA, "here is the file you asked for", "user", [
  {
    title: "quarterly-budget-2026.xlsx",
    url: "https://cdn.example.com/qb.xlsx",
  },
]);
seed(roomA, "duplicate marker zephyr", "user");
seed(roomA, "duplicate marker zephyr", "user");
const deletedMessageId = seed(
  roomA,
  "this redactable message says platypus once",
  "assistant",
);
seed(roomA, "the oldest xyzzy needle is buried here", "user");
for (let i = 0; i < 120; i++)
  seed(roomA, `filler chatter number ${i} nothing special`, "user");
seed(roomB, "roomB also mentions platypus separately", "user");
seed(roomDeletedConv, "platypus inside a deleted conversation", "user");
// The endpoint excludes deleted messages because the store no longer returns
// them; model that by dropping the row from the corpus the collaborator sees.
const liveRows = () => rows.filter((r) => r.id !== deletedMessageId);

const runtime = {
  agentId,
  searchMessages: (params: {
    roomIds: UUID[];
    query: string;
    limit?: number;
    offset?: number;
    since?: number;
    until?: number;
  }): Promise<MessageSearchHit[]> =>
    Promise.resolve(modelSearch(liveRows(), params)),
} as unknown as AgentRuntime;

interface Captured {
  status: number;
  body: {
    results: Array<{
      messageId: string;
      conversationId: string;
      roomId: string;
      role: "user" | "assistant";
      text: string;
      snippet: string;
      createdAt: number;
      score: number;
    }>;
    count: number;
  };
}

function conv(id: string, roomId: UUID): ConversationMeta {
  return {
    id,
    title: `conv ${id}`,
    roomId,
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(1).toISOString(),
  };
}

function makeState(): ConversationRouteState {
  return {
    runtime,
    conversations: new Map<string, ConversationMeta>([
      ["c-a", conv("c-a", roomA)],
      ["c-b", conv("c-b", roomB)],
      ["c-del", conv("c-del", roomDeletedConv)],
    ]),
    deletedConversationIds: new Set<string>(["c-del"]),
  } as unknown as ConversationRouteState;
}

function runSearch(
  qs: string,
  state: ConversationRouteState = makeState(),
): Promise<Captured> {
  return new Promise((resolve) => {
    const captured: Partial<Captured> = {};
    const ctx = {
      req: {
        url: `/api/conversations/messages/search?${qs}`,
        headers: { host: "localhost" },
      },
      res: {},
      method: "GET",
      pathname: "/api/conversations/messages/search",
      readJsonBody: vi.fn(),
      json: (_res: unknown, data: unknown, status = 200) => {
        captured.status = status;
        captured.body = data as Captured["body"];
        resolve(captured as Captured);
      },
      error: (_res: unknown, message: string, status = 500) => {
        captured.status = status;
        captured.body = { results: [], count: 0, error: message } as never;
        resolve(captured as Captured);
      },
      state,
    } as unknown as ConversationRouteContext;
    void handleConversationRoutes(ctx);
  });
}

const texts = (r: Captured) => r.body.results.map((x) => x.text);

describe("GET /api/conversations/messages/search (route boundary)", () => {
  it("multi-word non-adjacent — 'deploy agent' matches 'deploy your first agent'", async () => {
    const r = await runSearch("q=deploy%20agent");
    expect(r.status).toBe(200);
    expect(texts(r).some((t) => t.includes("deploy your first agent"))).toBe(
      true,
    );
  });

  it("case + accent + apostrophe fold; URL, emoji, CJK substrings", async () => {
    expect(
      texts(await runSearch("q=GITHUB")).some((t) => t.includes("GitHub")),
    ).toBe(true);
    expect(
      texts(await runSearch("q=cafe")).some((t) => t.includes("café")),
    ).toBe(true);
    expect(
      texts(await runSearch("q=dont")).some((t) => t.includes("don't")),
    ).toBe(true);
    expect(
      texts(
        await runSearch(`q=${encodeURIComponent("example.com/docs")}`),
      ).some((t) => t.includes("https://example.com/docs")),
    ).toBe(true);
    expect(
      texts(await runSearch(`q=${encodeURIComponent("🚀")}`)).some((t) =>
        t.includes("🚀"),
      ),
    ).toBe(true);
    expect(
      texts(await runSearch(`q=${encodeURIComponent("北京")}`)).some((t) =>
        t.includes("北京"),
      ),
    ).toBe(true);
  });

  it("code metacharacters literal — '%bob_%' finds the row, 'zzz%zzz' matches nothing", async () => {
    expect(
      texts(await runSearch(`q=${encodeURIComponent("%bob_%")}`)).some((t) =>
        t.includes("SELECT * FROM t"),
      ),
    ).toBe(true);
    expect(
      (await runSearch(`q=${encodeURIComponent("zzz%zzz")}`)).body.count,
    ).toBe(0);
  });

  it("attachment-only match via filename", async () => {
    expect(
      texts(
        await runSearch(`q=${encodeURIComponent("quarterly-budget")}`),
      ).some((t) => t.includes("here is the file you asked for")),
    ).toBe(true);
  });

  it("near-duplicates all returned, deterministically ordered", async () => {
    const dups = (await runSearch("q=zephyr")).body.results.filter(
      (x) => x.text === "duplicate marker zephyr",
    );
    expect(dups.length).toBe(2);
    expect(dups[0].createdAt).toBeGreaterThanOrEqual(dups[1].createdAt);
  });

  it("role attribution + snippet around the match", async () => {
    const r = await runSearch("q=configuring");
    const row = r.body.results.find((x) => x.text.includes("configuring"));
    expect(row?.role).toBe("assistant");
    expect(row?.snippet.toLowerCase()).toContain("configuring");
    const r2 = await runSearch("q=configuration");
    expect(
      r2.body.results.find((x) => x.text.includes("configuration"))?.role,
    ).toBe("user");
  });

  it("deleted message and deleted-conversation rows never appear; access-scoped", async () => {
    const r = await runSearch("q=platypus");
    expect(texts(r)).toEqual(["roomB also mentions platypus separately"]);
    expect(r.body.results.every((x) => x.conversationId === "c-b")).toBe(true);
  });

  it("corpus-wide recall — the oldest 'xyzzy' hit survives 120 newer rows", async () => {
    const r = await runSearch("q=xyzzy");
    expect(r.body.count).toBe(1);
    expect(r.body.results[0].text).toContain("oldest xyzzy needle");
  });

  it("empty / edge input", async () => {
    expect((await runSearch("q=a")).status).toBe(400);
    expect((await runSearch(`q=${encodeURIComponent("   ")}`)).status).toBe(
      400,
    );
    const longer = await runSearch(
      `q=${encodeURIComponent("this exact long sentence appears in absolutely no seeded message anywhere")}`,
    );
    expect(longer.status).toBe(200);
    expect(longer.body.count).toBe(0);
  });

  it("no accessible conversations → empty result without querying the store", async () => {
    const searchSpy = vi.spyOn(runtime, "searchMessages");
    const emptyState = {
      runtime,
      conversations: new Map(),
      deletedConversationIds: new Set<string>(),
    } as unknown as ConversationRouteState;
    const r = await runSearch("q=platypus", emptyState);
    expect(r.body.count).toBe(0);
    expect(searchSpy).not.toHaveBeenCalled();
    searchSpy.mockRestore();
  });

  it("garbage since/until is rejected with 400, never a silently-ignored filter", async () => {
    // Non-numeric, non-ISO, and empty strings are all invalid — the route must
    // 400 rather than search an unbounded window the caller did not ask for.
    expect((await runSearch("q=filler&since=notadate")).status).toBe(400);
    expect((await runSearch("q=filler&until=abc")).status).toBe(400);
    expect(
      (await runSearch(`q=filler&since=${encodeURIComponent("  ")}`)).status,
    ).toBe(400);
    expect(
      (await runSearch("q=filler&until=2026-13-45T99:99:99Z")).status,
    ).toBe(400);
  });

  it("since later than until is rejected with 400", async () => {
    const r = await runSearch("q=filler&since=5000&until=2000");
    expect(r.status).toBe(400);
  });

  it("valid epoch-ms and ISO 8601 bounds are accepted", async () => {
    expect((await runSearch("q=filler&since=1000&until=9999")).status).toBe(
      200,
    );
    // ISO 8601 parses without error even if it excludes the (year-1970) corpus.
    const iso = await runSearch(
      `q=filler&since=${encodeURIComponent("2026-01-01T00:00:00Z")}`,
    );
    expect(iso.status).toBe(200);
  });

  it("a since/until window narrows the corpus and never leaks a row outside it", async () => {
    // The 120 filler rows carry contiguous createdAt values (seeded 1000+seq).
    // A window strictly inside that span must return only the in-window rows,
    // never one outside — proving the store applies the bound the route forwards.
    const fillerTimes = liveRows()
      .filter((r) => r.text.includes("filler"))
      .map((r) => r.createdAt)
      .sort((a, b) => a - b);
    expect(fillerTimes.length).toBe(120);
    // Pick a 20-wide interior window well away from both ends.
    const since = fillerTimes[40];
    const until = fillerTimes[59];
    const expectedInWindow = fillerTimes.filter(
      (t) => t >= since && t <= until,
    ).length;
    expect(expectedInWindow).toBe(20);

    const windowed = await runSearch(
      `q=filler&limit=500&since=${since}&until=${until}`,
    );
    expect(windowed.status).toBe(200);
    // Only the in-window filler rows come back (limit 500 > 20, so no clamp).
    expect(windowed.body.count).toBe(20);
    expect(
      windowed.body.results.every(
        (x) => x.createdAt >= since && x.createdAt <= until,
      ),
    ).toBe(true);
    // A row just outside either bound is provably excluded.
    expect(
      windowed.body.results.some(
        (x) => x.createdAt < since || x.createdAt > until,
      ),
    ).toBe(false);
  });
});
