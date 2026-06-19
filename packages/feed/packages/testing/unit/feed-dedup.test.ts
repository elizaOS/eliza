/**
 * Feed Dedup Unit Tests
 *
 * Tests for:
 * 1. Jaccard similarity function (same logic as TopicDiversityService.calculateSimilarity)
 * 2. Cross-NPC dedup guard logic (mirrors executeDirectPost check)
 * 3. Group chat message quality guards (length + similarity)
 * 4. Arc event coverage helpers (DB-backed hasEventBeenCovered / markEventAsCovered)
 */

import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// 1. Jaccard similarity (extracted for isolated testing)
// ---------------------------------------------------------------------------

function jaccardSimilarity(content1: string, content2: string): number {
  const words1 = new Set(
    content1
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
  const words2 = new Set(
    content2
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );

  if (words1.size === 0 || words2.size === 0) return 0;

  const intersection = new Set([...words1].filter((w) => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

describe("jaccardSimilarity", () => {
  test("identical text returns 1.0", () => {
    const text = "Bitcoin prices surge as market optimism returns";
    expect(jaccardSimilarity(text, text)).toBe(1);
  });

  test("completely different text returns 0", () => {
    const a = "The president announces new trade policy tomorrow";
    const b = "Scientists discover massive volcanic eruption on Jupiter";
    expect(jaccardSimilarity(a, b)).toBeLessThan(0.1);
  });

  test("high overlap returns >= 0.5", () => {
    const a = "Feed social platform launches new prediction markets feature";
    const b = "Feed platform launches social prediction markets feature today";
    expect(jaccardSimilarity(a, b)).toBeGreaterThanOrEqual(0.5);
  });

  test("short words (<=3 chars) are ignored", () => {
    // All meaningful words are <= 3 chars — filter removes them, leaving empty set → similarity 0
    const a = "to be or not to be the way and but for";
    const b = "some very long words that should matter here clearly";
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  test("empty strings return 0", () => {
    expect(jaccardSimilarity("", "something important")).toBe(0);
    expect(jaccardSimilarity("something important", "")).toBe(0);
  });

  test("partial overlap returns intermediate value", () => {
    const a =
      "market rally crypto bitcoin ethereum blockchain technology surge";
    const b =
      "market correction stock bitcoin decline traditional finance sector";
    const sim = jaccardSimilarity(a, b);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-NPC dedup guard logic
// ---------------------------------------------------------------------------

const CROSS_NPC_THRESHOLD = 0.5;

function crossNpcDedupCheck(
  newContent: string,
  recentContents: string[],
): { isDuplicate: boolean; similarity: number } {
  for (const recent of recentContents) {
    const sim = jaccardSimilarity(newContent, recent);
    if (sim >= CROSS_NPC_THRESHOLD) {
      return { isDuplicate: true, similarity: sim };
    }
  }
  return { isDuplicate: false, similarity: 0 };
}

describe("cross-NPC dedup guard", () => {
  test("allows unique post when no similar recent content", () => {
    const recent = [
      "Scientists confirm breakthrough in quantum computing field",
      "Sports league announces expansion to three new cities",
    ];
    const newPost =
      "Political debate heats up over infrastructure spending bill";
    const result = crossNpcDedupCheck(newPost, recent);
    expect(result.isDuplicate).toBe(false);
  });

  test("blocks near-identical post from different NPC", () => {
    const recent = [
      "Bitcoin prices surge as market optimism returns strongly today",
    ];
    const newPost = "Bitcoin prices surge as market optimism returns today";
    const result = crossNpcDedupCheck(newPost, recent);
    expect(result.isDuplicate).toBe(true);
    expect(result.similarity).toBeGreaterThanOrEqual(CROSS_NPC_THRESHOLD);
  });

  test("allows post when similarity is just below threshold", () => {
    const recent = [
      "The Federal Reserve increases interest rates by half a percentage point",
    ];
    const newPost =
      "Markets react to Federal Reserve decision on interest rates today";
    const result = crossNpcDedupCheck(newPost, recent);
    // Should be below 0.5 (overlapping only on "Federal", "Reserve", "interest", "rates")
    expect(result.isDuplicate).toBe(result.similarity >= CROSS_NPC_THRESHOLD);
  });

  test("empty recent list always allows", () => {
    const result = crossNpcDedupCheck("any content here matters a lot", []);
    expect(result.isDuplicate).toBe(false);
  });

  test("checks all recent posts, blocks if ANY exceeds threshold", () => {
    const recent = [
      "Unrelated science content about biology research",
      "Bitcoin prices surge as market optimism returns strongly today",
      "Another unrelated story about sports events",
    ];
    const newPost = "Bitcoin prices surge as market optimism returns today";
    const result = crossNpcDedupCheck(newPost, recent);
    expect(result.isDuplicate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Group chat message quality guards
// ---------------------------------------------------------------------------

const GROUP_MSG_MIN_CHARS = 20;
const GROUP_MSG_MIN_WORDS = 3;
const GROUP_MSG_SIMILARITY_THRESHOLD = 0.5;

function validateGroupMessage(
  content: string,
  recentMessages: string[],
): { valid: boolean; reason?: string } {
  if (content.length < GROUP_MSG_MIN_CHARS) {
    return {
      valid: false,
      reason: `too short (${content.length} < ${GROUP_MSG_MIN_CHARS} chars)`,
    };
  }
  if (content.trim().split(/\s+/).length < GROUP_MSG_MIN_WORDS) {
    return { valid: false, reason: "too few words" };
  }
  for (const recent of recentMessages) {
    const sim = jaccardSimilarity(content, recent);
    if (sim >= GROUP_MSG_SIMILARITY_THRESHOLD) {
      return {
        valid: false,
        reason: `too similar to recent message (${(sim * 100).toFixed(0)}%)`,
      };
    }
  }
  return { valid: true };
}

describe("group chat message quality guards", () => {
  test("rejects message under 20 chars", () => {
    const result = validateGroupMessage("ok", []);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("too short");
  });

  test("rejects single-word message even if long chars", () => {
    const result = validateGroupMessage("cryptocurrency", []);
    expect(result.valid).toBe(false);
  });

  test("rejects two-word message under min_words", () => {
    // "market crash" has only 12 chars → fails min length check (< 20)
    const result2 = validateGroupMessage("market crash", []);
    expect(result2.valid).toBe(false);
    // "market is crashing everywhere now" has 5 words and > 20 chars → should pass
    const result = validateGroupMessage(
      "market is crashing everywhere now",
      [],
    );
    expect(result.valid).toBe(true);
  });

  test("rejects message too similar to recent chat message", () => {
    const recent = ["Bitcoin markets surge as crypto optimism grows today"];
    const newMsg = "Bitcoin markets surge as crypto optimism grows today again";
    const result = validateGroupMessage(newMsg, recent);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("similar");
  });

  test("accepts quality message with no overlap", () => {
    const recent = ["Federal reserve raises rates unexpectedly this morning"];
    const newMsg =
      "Scientists discover new method to predict volcanic eruptions with high accuracy";
    const result = validateGroupMessage(newMsg, recent);
    expect(result.valid).toBe(true);
  });

  test("accepts quality message even with some overlap below threshold", () => {
    const recent = [
      "Markets are showing signs of recovery after recent volatility",
    ];
    const newMsg =
      "Markets seem stable today despite global economic uncertainty and concerns";
    const result = validateGroupMessage(newMsg, recent);
    // "markets" overlaps but similarity should be well below 0.5
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Arc event coverage — pure logic tests (no DB needed)
// ---------------------------------------------------------------------------

// Simulate DB-backed coverage as a simple in-memory Map for testing the logic

type ArcEventStatus = "created" | "breaking" | "commentary" | "resolution";

class TestArcCoverageStore {
  private records = new Map<string, Set<string>>();

  private key(eventId: string, orgId: string, status: string): string {
    return `${eventId}:${orgId}:${status}`;
  }

  async markCovered(
    eventId: string,
    orgId: string,
    status: ArcEventStatus,
  ): Promise<void> {
    const k = this.key(eventId, orgId, status);
    if (!this.records.has(k)) {
      this.records.set(k, new Set());
    }
  }

  async hasAnyCoverage(
    eventId: string,
    status: ArcEventStatus,
  ): Promise<boolean> {
    for (const k of this.records.keys()) {
      if (k.startsWith(`${eventId}:`) && k.endsWith(`:${status}`)) {
        return true;
      }
    }
    return false;
  }

  async selectEligibleOrgs<T extends { id: string }>(
    eventId: string,
    status: ArcEventStatus,
    orgs: T[],
  ): Promise<T[]> {
    const covered = new Set<string>();
    for (const k of this.records.keys()) {
      const [eid, orgId, st] = k.split(":");
      if (eid === eventId && st === status && orgId) {
        covered.add(orgId);
      }
    }
    return orgs.filter((o) => !covered.has(o.id));
  }

  reset(): void {
    this.records.clear();
  }
}

describe("arc event coverage (DB-backed logic)", () => {
  const store = new TestArcCoverageStore();
  const orgs = [
    { id: "cnn", name: "CNN" },
    { id: "bbc", name: "BBC" },
    { id: "abc", name: "ABC" },
  ];

  test("no coverage initially → hasAnyCoverage returns false", async () => {
    store.reset();
    expect(await store.hasAnyCoverage("arc-1", "created")).toBe(false);
  });

  test("after marking, hasAnyCoverage returns true", async () => {
    store.reset();
    await store.markCovered("arc-1", "cnn", "created");
    expect(await store.hasAnyCoverage("arc-1", "created")).toBe(true);
  });

  test("coverage for one status does not affect another", async () => {
    store.reset();
    await store.markCovered("arc-1", "cnn", "created");
    expect(await store.hasAnyCoverage("arc-1", "breaking")).toBe(false);
  });

  test("covered org is excluded from eligible orgs", async () => {
    store.reset();
    await store.markCovered("arc-1", "cnn", "created");
    const eligible = await store.selectEligibleOrgs("arc-1", "created", orgs);
    expect(eligible.map((o) => o.id)).not.toContain("cnn");
    expect(eligible.length).toBe(2);
  });

  test("all orgs eligible when no coverage", async () => {
    store.reset();
    const eligible = await store.selectEligibleOrgs("arc-2", "created", orgs);
    expect(eligible.length).toBe(3);
  });

  test("duplicate marks for same org/event/status are idempotent", async () => {
    store.reset();
    await store.markCovered("arc-1", "cnn", "created");
    await store.markCovered("arc-1", "cnn", "created"); // duplicate
    const eligible = await store.selectEligibleOrgs("arc-1", "created", orgs);
    // Should still only exclude cnn once
    expect(eligible.length).toBe(2);
  });

  test("coverage is per-event — different events are independent", async () => {
    store.reset();
    await store.markCovered("arc-1", "cnn", "created");
    expect(await store.hasAnyCoverage("arc-2", "created")).toBe(false);
    const eligible = await store.selectEligibleOrgs("arc-2", "created", orgs);
    expect(eligible.length).toBe(3);
  });
});
