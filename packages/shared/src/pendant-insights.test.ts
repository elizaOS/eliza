import { describe, expect, it } from "vitest";
import { PostPendantInsightsRequestSchema } from "./contracts/pendant-insights-routes.js";
import {
  composePendantInsights,
  extractFirstJsonObject,
  fnv1a32,
  isEmptyInsights,
  isPendantSegmentId,
  makePendantSegmentId,
  PENDANT_INSIGHTS_SCHEMA_VERSION,
  PendantInsightsModelOutputSchema,
  PendantInsightsSchema,
  parsePendantInsights,
  parsePendantInsightsModelOutput,
} from "./pendant-insights.js";

describe("pendant insights route contract", () => {
  const segment = { id: "s1", ordinal: 0, text: "hello" };

  it("requires an explicit enabled=true assertion", () => {
    expect(
      PostPendantInsightsRequestSchema.safeParse({ segments: [segment] })
        .success,
    ).toBe(false);
    expect(
      PostPendantInsightsRequestSchema.safeParse({
        enabled: false,
        segments: [segment],
      }).success,
    ).toBe(false);
    expect(
      PostPendantInsightsRequestSchema.safeParse({
        enabled: true,
        segments: [segment],
      }).success,
    ).toBe(true);
  });
});

describe("fnv1a32", () => {
  it("is deterministic + 8 hex chars", () => {
    const a = fnv1a32("hello world");
    expect(a).toBe(fnv1a32("hello world"));
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
  it("differs for different input", () => {
    expect(fnv1a32("a")).not.toBe(fnv1a32("b"));
  });
});

describe("makePendantSegmentId", () => {
  it("is deterministic for (session, ordinal, text)", () => {
    const id = makePendantSegmentId("sess-1", 3, "buy milk");
    expect(makePendantSegmentId("sess-1", 3, "buy milk")).toBe(id);
    expect(isPendantSegmentId(id)).toBe(true);
    expect(id.startsWith("pseg_")).toBe(true);
  });
  it("changes when text changes (no ordinal collision)", () => {
    expect(makePendantSegmentId("s", 0, "one")).not.toBe(
      makePendantSegmentId("s", 0, "two"),
    );
  });
  it("sanitizes the session id + floors negative ordinals", () => {
    const id = makePendantSegmentId("a b/c!", -5, "x");
    expect(id).toContain("_abc_");
    expect(id).toContain("_0_");
  });
  it("does not collide when sanitized session labels match", () => {
    expect(makePendantSegmentId("a-b", 0, "x")).not.toBe(
      makePendantSegmentId("ab", 0, "x"),
    );
  });
  it("isPendantSegmentId rejects non-strings + foreign ids", () => {
    expect(isPendantSegmentId(42)).toBe(false);
    expect(isPendantSegmentId("s1")).toBe(false);
  });
});

describe("PendantInsightsModelOutputSchema", () => {
  it("defaults every list + summary from a bare {}", () => {
    const parsed = PendantInsightsModelOutputSchema.parse({});
    expect(parsed).toEqual({
      summary: "",
      actionItems: [],
      topics: [],
      peopleMentioned: [],
      notableQuotes: [],
    });
  });
  it("trims summary, dedupes sourceSegmentIds, drops extra keys", () => {
    const parsed = PendantInsightsModelOutputSchema.parse({
      summary: "  hi  ",
      actionItems: [
        { text: "do x", confidence: 0.9, sourceSegmentIds: ["a", "a", "b"] },
      ],
      junk: "ignored",
    });
    expect(parsed.summary).toBe("hi");
    expect(parsed.actionItems[0].sourceSegmentIds).toEqual(["a", "b"]);
    expect(parsed).not.toHaveProperty("junk");
  });
  it("rejects a confidence out of range", () => {
    const r = PendantInsightsModelOutputSchema.safeParse({
      actionItems: [{ text: "x", confidence: 2, sourceSegmentIds: [] }],
    });
    expect(r.success).toBe(false);
  });
  it("rejects an empty action item text or missing evidence", () => {
    const r = PendantInsightsModelOutputSchema.safeParse({
      actionItems: [{ text: "   ", confidence: 0.5, sourceSegmentIds: [] }],
    });
    expect(r.success).toBe(false);
    expect(
      PendantInsightsModelOutputSchema.safeParse({
        actionItems: [{ text: "do x", confidence: 0.5, sourceSegmentIds: [] }],
      }).success,
    ).toBe(false);
  });
  it("validates action-item dueAt as ISO-8601", () => {
    expect(
      PendantInsightsModelOutputSchema.safeParse({
        actionItems: [
          {
            text: "do x",
            dueAt: "tomorrow",
            confidence: 0.8,
            sourceSegmentIds: ["s1"],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("PendantInsightsSchema (full record)", () => {
  it("parses a minimal well-formed record", () => {
    const r = PendantInsightsSchema.safeParse({
      generatedAt: 123,
      transcriptRange: {
        startOrdinal: 0,
        endOrdinal: 2,
        segmentCount: 3,
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.schemaVersion).toBe(PENDANT_INSIGHTS_SCHEMA_VERSION);
      expect(r.data.summary).toBe("");
      expect(r.data.transcriptRange.startedAtMs).toBe(0);
    }
  });
  it("rejects a wrong schemaVersion literal", () => {
    const r = PendantInsightsSchema.safeParse({
      schemaVersion: 999,
      generatedAt: 1,
      transcriptRange: { startOrdinal: 0, endOrdinal: 0, segmentCount: 0 },
    });
    expect(r.success).toBe(false);
  });
});

describe("parsePendantInsights (fail-closed)", () => {
  it("rejects an unknown schemaVersion with a readable reason", () => {
    const r = parsePendantInsights({ schemaVersion: 2, generatedAt: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unsupported.*schemaVersion.*2/);
  });
  it("rejects malformed input without throwing", () => {
    const r = parsePendantInsights({ generatedAt: "nope" });
    expect(r.ok).toBe(false);
  });
  it("accepts current and unversioned v1 records for backward compatibility", () => {
    const current = parsePendantInsights({
      schemaVersion: 1,
      generatedAt: 5,
      transcriptRange: { startOrdinal: 0, endOrdinal: 0, segmentCount: 1 },
    });
    const legacyUnversioned = parsePendantInsights({
      generatedAt: 5,
      transcriptRange: { startOrdinal: 0, endOrdinal: 0, segmentCount: 1 },
    });
    expect(current.ok).toBe(true);
    expect(legacyUnversioned.ok).toBe(true);
    if (legacyUnversioned.ok)
      expect(legacyUnversioned.value.schemaVersion).toBe(1);
  });
  it("rejects internally inconsistent ranges", () => {
    expect(
      parsePendantInsights({
        generatedAt: 5,
        transcriptRange: { startOrdinal: 4, endOrdinal: 2, segmentCount: 2 },
      }).ok,
    ).toBe(false);
  });
});

describe("extractFirstJsonObject", () => {
  it("extracts a bare object", () => {
    expect(extractFirstJsonObject('{"a":1}')).toBe('{"a":1}');
  });
  it("extracts from code fences + prose", () => {
    const raw = 'Here you go:\n```json\n{"a": {"b": 2}}\n```\nDone.';
    expect(extractFirstJsonObject(raw)).toBe('{"a": {"b": 2}}');
  });
  it("is string-literal aware (a brace inside a string doesn't close early)", () => {
    const raw = '{"text": "a } b", "n": 1}';
    expect(extractFirstJsonObject(raw)).toBe(raw);
  });
  it("returns null when no object is present", () => {
    expect(extractFirstJsonObject("no json here")).toBeNull();
  });
});

describe("parsePendantInsightsModelOutput", () => {
  it("parses a JSON string wrapped in prose", () => {
    const r = parsePendantInsightsModelOutput(
      'Sure!\n{"summary":"talked about x","topics":[]}\nThanks',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.summary).toBe("talked about x");
  });
  it("parses an already-parsed object", () => {
    const r = parsePendantInsightsModelOutput({ summary: "hi" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.summary).toBe("hi");
  });
  it("fails on a string with no JSON object", () => {
    const r = parsePendantInsightsModelOutput("I refuse to answer.");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no JSON object/);
  });
  it("fails on invalid JSON", () => {
    const r = parsePendantInsightsModelOutput("{ not: valid json ]");
    expect(r.ok).toBe(false);
  });
  it("fails on a shape violation (bad confidence)", () => {
    const r = parsePendantInsightsModelOutput(
      '{"actionItems":[{"text":"x","confidence":5,"sourceSegmentIds":[]}]}',
    );
    expect(r.ok).toBe(false);
  });
});

describe("composePendantInsights", () => {
  const model = PendantInsightsModelOutputSchema.parse({
    summary: "s",
    actionItems: [
      { text: "task", confidence: 0.8, sourceSegmentIds: ["known", "ghost"] },
    ],
    topics: [{ label: "t", salience: 0.5, sourceSegmentIds: ["ghost"] }],
    peopleMentioned: [{ name: "Sam", sourceSegmentIds: ["known"] }],
    notableQuotes: [{ text: "q", sourceSegmentIds: ["ghost", "known"] }],
  });

  it("stamps server-owned fields + filters unknown segment ids", () => {
    const out = composePendantInsights({
      model,
      generatedAt: 999,
      transcriptRange: { startOrdinal: 0, endOrdinal: 1, segmentCount: 2 },
      knownSegmentIds: new Set(["known"]),
    });
    expect(out.schemaVersion).toBe(PENDANT_INSIGHTS_SCHEMA_VERSION);
    expect(out.generatedAt).toBe(999);
    // "ghost" was never in the window → filtered out everywhere.
    expect(out.actionItems[0].sourceSegmentIds).toEqual(["known"]);
    expect(out.topics).toEqual([]);
    expect(out.notableQuotes[0].sourceSegmentIds).toEqual(["known"]);
    // The composed record round-trips through the full validator.
    expect(parsePendantInsights(out).ok).toBe(true);
  });
});

describe("isEmptyInsights", () => {
  it("true for a quiet window, false when anything is present", () => {
    const base = composePendantInsights({
      model: PendantInsightsModelOutputSchema.parse({}),
      generatedAt: 1,
      transcriptRange: { startOrdinal: 0, endOrdinal: 0, segmentCount: 0 },
      knownSegmentIds: new Set(),
    });
    expect(isEmptyInsights(base)).toBe(true);
    expect(isEmptyInsights({ ...base, summary: "x" })).toBe(false);
  });
});
