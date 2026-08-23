/**
 * Coverage for the recency-tiered OpenClaw memory seeder: firewall posture,
 * the CURRENT/LONGTERM/SELF/MARKER tiers, window and minimum-length filters,
 * lossless max-length chunking, and tier-priority cross-tier dedup. Drives the real
 * `tierMemories` over hand-built sources — no mocks, no filesystem.
 */

import { describe, expect, it } from "vitest";
import {
  type MemoryTier,
  type TieringOptions,
  type TieringResult,
  tierMemories,
} from "./memory-tiering.js";
import type { OcAgentSource } from "./openclaw-reader.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function emptySource(): OcAgentSource {
  return {
    agentId: "tester",
    home: "/unused",
    dailyLogs: [],
    namedMemory: [],
    hasSecretsDir: false,
    sqliteStores: [],
    sqliteUningested: false,
    warnings: [],
  };
}

function opts(overrides: Partial<TieringOptions> = {}): TieringOptions {
  return {
    memoryDays: 14,
    roomId: "room-0000-0000",
    entityId: "entity-0000-000",
    agentId: "agent-0000-0000",
    ...overrides,
  };
}

/** A source exercising every tier: awareness, fresh + ancient logs, MEMORY.md, journal. */
function richSource(): OcAgentSource {
  const now = Date.now();
  return {
    ...emptySource(),
    awareness: "Current open threads live here",
    curatedMemory: "# Work\ncurated work fact worth keeping",
    dailyLogs: [
      {
        date: "2026-08-20",
        epochMs: now - 2 * DAY_MS,
        filename: "2026-08-20.md",
        text: "fresh daily log entry content",
      },
      {
        date: "2020-01-01",
        epochMs: now - 400 * DAY_MS,
        filename: "2020-01-01.md",
        text: "ancient daily log entry content",
      },
    ],
    namedMemory: [
      {
        key: "journal",
        filename: "journal.md",
        text: "private becoming notes",
      },
    ],
  };
}

function tierOf(result: TieringResult, tier: MemoryTier) {
  return result.memories.filter((m) => m.metadata.tier === tier);
}

describe("tierMemories", () => {
  it("returns an empty result for an empty source", () => {
    const result = tierMemories(emptySource(), opts());
    expect(result.memories).toEqual([]);
    expect(result.counts).toEqual({
      CURRENT: 0,
      LONGTERM: 0,
      SELF: 0,
      MARKER: 0,
    });
    expect(result.duplicatesDropped).toBe(0);
    expect(result.clipped).toBe(0);
  });

  it("firewall=true seeds only the privacy MARKER out of a rich source", () => {
    const result = tierMemories(richSource(), opts({ firewall: true }));
    expect(result.memories).toHaveLength(1);
    const marker = result.memories[0];
    expect(marker.metadata.tier).toBe("MARKER");
    expect(marker.content.text.startsWith("[MARKER] ")).toBe(true);
    expect(marker.content.text).toContain("firewalled");
    expect(result.counts).toEqual({
      CURRENT: 0,
      LONGTERM: 0,
      SELF: 0,
      MARKER: 1,
    });
    expect(result.duplicatesDropped).toBe(0);
    expect(result.clipped).toBe(0);
  });

  it("defaults firewall to false so the full corpus is seeded", () => {
    const result = tierMemories(richSource(), opts());
    expect(result.memories.length).toBeGreaterThan(1);
    // The 400-day-old log yields exactly one older-history summary marker;
    // the privacy MARKER path is the only other source and stays silent.
    expect(tierOf(result, "MARKER")).toHaveLength(1);
    expect(tierOf(result, "MARKER")[0].content.text).toContain(
      "(1 daily logs before",
    );
    expect(tierOf(result, "CURRENT").length).toBeGreaterThan(0);
    expect(tierOf(result, "LONGTERM").length).toBeGreaterThan(0);
    expect(tierOf(result, "SELF").length).toBeGreaterThan(0);
  });

  it("seeds awareness verbatim as CURRENT with provenance metadata", () => {
    const before = Date.now();
    const seeded = tierMemories(
      { ...emptySource(), awareness: "  Live awareness body  " },
      opts(),
    );
    const after = Date.now();
    expect(seeded.memories).toHaveLength(1);
    const mem = seeded.memories[0];
    expect(mem.content.text).toBe("[CURRENT] Live awareness body");
    expect(mem.metadata).toEqual({
      type: "custom",
      source: "openclaw-migration",
      tier: "CURRENT",
    });
    expect(mem.unique).toBe(true);
    expect(mem.entityId).toBe("entity-0000-000");
    expect(mem.agentId).toBe("agent-0000-0000");
    expect(mem.roomId).toBe("room-0000-0000");
    expect(mem.createdAt).toBeGreaterThanOrEqual(before);
    expect(mem.createdAt).toBeLessThanOrEqual(after);

    // Whitespace-only awareness is treated as absent.
    const blank = tierMemories(
      { ...emptySource(), awareness: "   \n\t  " },
      opts(),
    );
    expect(blank.memories).toEqual([]);
  });

  it("seeds only in-window daily logs as CURRENT and summarizes the rest", () => {
    const now = Date.now();
    const recentA = now - 2 * DAY_MS;
    const recentB = now - 3 * DAY_MS;
    const ancient = now - 40 * DAY_MS;
    const result = tierMemories(
      {
        ...emptySource(),
        awareness: "anchor for internal-now timestamps",
        dailyLogs: [
          {
            date: "2026-08-22",
            epochMs: recentA,
            filename: "2026-08-22.md",
            text: "newest daily log body here",
          },
          {
            date: "2026-08-21",
            epochMs: recentB,
            filename: "2026-08-21.md",
            text: "older-but-still-recent log body",
          },
          {
            date: "2020-06-01",
            epochMs: ancient,
            filename: "2020-06-01.md",
            text: "ancient daily log body kept out",
          },
        ],
      },
      opts(),
    );

    const current = tierOf(result, "CURRENT");
    expect(current.map((m) => m.content.text)).toEqual([
      "[CURRENT] anchor for internal-now timestamps",
      "[CURRENT] daily log 2026-08-22\nnewest daily log body here",
      "[CURRENT] daily log 2026-08-21\nolder-but-still-recent log body",
    ]);
    // In-window memories carry their own log timestamp, not seed time.
    expect(current[1].createdAt).toBe(recentA);
    expect(current[2].createdAt).toBe(recentB);

    // One summary marker instead of flat-seeding stale logs; anchored at the
    // window edge minus 1ms relative to the awareness seed time.
    const markers = tierOf(result, "MARKER");
    expect(markers).toHaveLength(1);
    expect(markers[0].content.text).toContain("(1 daily logs before");
    expect(markers[0].content.text).toContain("back to 2020-06-01");
    const internalNow = current[0].createdAt;
    expect(markers[0].createdAt).toBe(
      internalNow - opts().memoryDays * DAY_MS - 1,
    );
    expect(result.counts).toEqual({
      CURRENT: 3,
      LONGTERM: 0,
      SELF: 0,
      MARKER: 1,
    });
  });

  it("skips in-window daily logs below minChunkLen entirely", () => {
    const now = Date.now();
    const source: OcAgentSource = {
      ...emptySource(),
      dailyLogs: [
        {
          date: "2026-08-22",
          epochMs: now - 1 * DAY_MS,
          filename: "2026-08-22.md",
          text: "small entry",
        },
      ],
    };
    const strict = tierMemories(source, opts());
    expect(strict.memories).toEqual([]);
    expect(Object.values(strict.counts).every((n) => n === 0)).toBe(true);

    const lenient = tierMemories(source, opts({ minChunkLen: 5 }));
    expect(tierOf(lenient, "CURRENT")).toHaveLength(1);
    expect(lenient.counts.CURRENT).toBe(1);
    expect(lenient.counts.MARKER).toBe(0);
  });

  it("counts unparseable-timestamp logs as older history", () => {
    const result = tierMemories(
      {
        ...emptySource(),
        dailyLogs: [
          { date: null, epochMs: 0, filename: "unknown-date.md", text: "" },
        ],
      },
      opts(),
    );
    expect(result.memories).toHaveLength(1);
    const marker = result.memories[0];
    expect(marker.metadata.tier).toBe("MARKER");
    expect(marker.content.text).toContain("(1 daily logs before");
    expect(marker.content.text).toContain("back to earlier");
    expect(result.counts.MARKER).toBe(1);
    expect(result.counts.CURRENT).toBe(0);
    // Anchored just below the window edge, not at seed time.
    expect(
      Math.abs(marker.createdAt - (Date.now() - 14 * DAY_MS)),
    ).toBeLessThan(60_000);
  });

  it("chunks curated MEMORY.md by top-level headings into LONGTERM", () => {
    const result = tierMemories(
      {
        ...emptySource(),
        awareness: "time anchor",
        curatedMemory: [
          "# Work",
          "first curated section body here",
          "",
          "## Projects",
          "second curated section body",
          "",
          "## Tiny",
          "no",
        ].join("\n"),
      },
      opts(),
    );

    const longterm = tierOf(result, "LONGTERM");
    // The too-small "Tiny" section is dropped by minChunkLen.
    expect(longterm.map((m) => m.content.text)).toEqual([
      "[LONGTERM] # Work\nfirst curated section body here",
      "[LONGTERM] ## Projects\nsecond curated section body",
    ]);
    const internalNow = tierOf(result, "CURRENT")[0].createdAt;
    for (const mem of longterm) {
      expect(mem.createdAt).toBe(internalNow - 1);
    }
    expect(result.counts.LONGTERM).toBe(2);
  });

  it("does not split chunks on deeper ### sub-headings", () => {
    const result = tierMemories(
      {
        ...emptySource(),
        curatedMemory: "intro paragraph line\n### deep\ndeep body text here",
      },
      opts({ minChunkLen: 5 }),
    );
    const longterm = tierOf(result, "LONGTERM");
    expect(longterm).toHaveLength(1);
    expect(longterm[0].content.text).toBe(
      "[LONGTERM] intro paragraph line\n### deep\ndeep body text here",
    );
  });

  it("seeds SELF journals verbatim and ignores non-self named memory", () => {
    const result = tierMemories(
      {
        ...emptySource(),
        awareness: "time anchor",
        namedMemory: [
          {
            key: "conversation-playbook",
            filename: "conversation-playbook.md",
            text: "long playbook text that is not a journal",
          },
          {
            key: "thoughts",
            filename: "thoughts.md",
            text: "tiny",
          },
          {
            key: "inner-state",
            filename: "inner-state.md",
            text: "becoming journal prose here",
          },
        ],
      },
      opts(),
    );

    const self = tierOf(result, "SELF");
    expect(self).toHaveLength(1);
    expect(self[0].content.text).toBe(
      "[SELF] inner-state\nbecoming journal prose here",
    );
    const internalNow = tierOf(result, "CURRENT")[0].createdAt;
    expect(self[0].createdAt).toBe(internalNow - 2);
    expect(result.counts.SELF).toBe(1);
    expect(result.counts.CURRENT).toBe(1);
  });

  it("keeps the highest-priority copy when a fact spans tiers", () => {
    const result = tierMemories(
      {
        ...emptySource(),
        awareness: "Standup   moved to THURSDAYS",
        curatedMemory:
          "standup moved to thursdays\n# Personal\nunrelated personal note",
      },
      opts(),
    );

    // The CURRENT copy survives verbatim; the LONGTERM duplicate is dropped
    // while the unrelated section survives.
    expect(result.duplicatesDropped).toBe(1);
    expect(result.memories.map((m) => m.content.text)).toEqual([
      "[CURRENT] Standup   moved to THURSDAYS",
      "[LONGTERM] # Personal\nunrelated personal note",
    ]);
    expect(result.counts).toEqual({
      CURRENT: 1,
      LONGTERM: 1,
      SELF: 0,
      MARKER: 0,
    });
  });

  it("keeps the first copy when one tier repeats the same fact", () => {
    const now = Date.now();
    const row = {
      date: "2026-08-21",
      epochMs: now - 2 * DAY_MS,
      filename: "2026-08-21.md",
      text: "repeated identical entry here today",
    };
    // Duplicate rows occur when markdown and sqlite ingestion overlap.
    const result = tierMemories(
      { ...emptySource(), dailyLogs: [row, { ...row }] },
      opts(),
    );
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].metadata.tier).toBe("CURRENT");
    expect(result.memories[0].content.text).toBe(
      "[CURRENT] daily log 2026-08-21\nrepeated identical entry here today",
    );
    expect(result.duplicatesDropped).toBe(1);
    expect(result.counts.CURRENT).toBe(1);
  });

  it("splits oversized bodies losslessly with an ordered reassembly contract", () => {
    const awareness = `${"x".repeat(49)}😀${"y".repeat(151)}`;
    const chunkedResult = tierMemories(
      { ...emptySource(), awareness },
      opts({ maxChunkLen: 50 }),
    );
    expect(chunkedResult.clipped).toBe(0);
    expect(chunkedResult.memories).toHaveLength(5);
    expect(chunkedResult.counts.CURRENT).toBe(5);

    const groupIds = new Set(
      chunkedResult.memories.map((memory) => memory.metadata.chunkGroupId),
    );
    expect(groupIds.size).toBe(1);
    expect(groupIds.has(undefined)).toBe(false);
    expect(
      chunkedResult.memories.map((memory) => memory.metadata.chunkIndex),
    ).toEqual([0, 1, 2, 3, 4]);
    expect(
      chunkedResult.memories.every(
        (memory) => memory.metadata.chunkCount === 5,
      ),
    ).toBe(true);

    const reassembled = [...chunkedResult.memories]
      .sort(
        (a, b) => (a.metadata.chunkIndex ?? 0) - (b.metadata.chunkIndex ?? 0),
      )
      .map((memory) => memory.content.text.replace(/^\[CURRENT\] /, ""))
      .join("");
    expect(reassembled).toBe(awareness);
    expect(
      chunkedResult.memories.every(
        (memory) =>
          Array.from(memory.content.text.replace(/^\[CURRENT\] /, "")).length <=
          50,
      ),
    ).toBe(true);

    const intact = tierMemories(
      { ...emptySource(), awareness },
      opts({ maxChunkLen: 6000 }),
    );
    expect(intact.clipped).toBe(0);
    expect(intact.memories[0].content.text).toBe(`[CURRENT] ${awareness}`);
  });

  it("rejects invalid maxChunkLen values before returning partial memories", () => {
    for (const maxChunkLen of [0, -1, 1.5]) {
      expect(() =>
        tierMemories(
          { ...emptySource(), awareness: "complete source text" },
          opts({ maxChunkLen }),
        ),
      ).toThrow(/maxChunkLen must be a positive integer/);
    }
  });

  it("assigns unique ids across a full multi-tier run", () => {
    const result = tierMemories(richSource(), opts());
    const ids = new Set(result.memories.map((m) => m.id));
    expect(ids.size).toBe(result.memories.length);
  });
});
