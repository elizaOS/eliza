import { describe, expect, it } from "bun:test";
import {
  parseMemoriesSafe,
  parseRelationshipsSafe,
  validateMemory,
  validateRelationshipUpdate,
} from "../../engine/src/services/jsonb-validators";

/**
 * JSONB validators guard corrupted DB columns. The READ path
 * (parse*Safe) must never throw: it salvages valid rows and drops corrupt
 * ones. The WRITE path (validate*) must throw on invalid input so bad data
 * never gets persisted.
 */

const memory = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  type: "posted",
  timestamp: "2026-06-23T00:00:00Z",
  summary: "did a thing",
  sentiment: 0.5,
  ...over,
});

describe("parseMemoriesSafe (read path — never throws)", () => {
  it("returns [] for null/undefined and non-array junk", () => {
    expect(parseMemoriesSafe(null)).toEqual([]);
    expect(parseMemoriesSafe(undefined)).toEqual([]);
    expect(parseMemoriesSafe("garbage")).toEqual([]);
  });

  it("passes a fully-valid array through", () => {
    const out = parseMemoriesSafe([memory(), memory({ id: "m2" })]);
    expect(out).toHaveLength(2);
  });

  it("salvages valid entries and drops corrupt ones", () => {
    const out = parseMemoriesSafe([
      memory(),
      { id: "bad", type: "not-a-type" }, // corrupt
      memory({ id: "m3", sentiment: 5 }), // sentiment out of [-1,1]
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("m1");
  });
});

describe("parseRelationshipsSafe (read path)", () => {
  const rel = {
    actorId: "a1",
    sentiment: 0.2,
    lastInteraction: "2026-06-23T00:00:00Z",
    interactionCount: 3,
    notes: [],
  };

  it("returns {} for null and salvages valid map entries", () => {
    expect(parseRelationshipsSafe(null)).toEqual({});
    const out = parseRelationshipsSafe({ a1: rel, a2: { actorId: "a2" } });
    expect(Object.keys(out)).toEqual(["a1"]);
  });
});

describe("validate* (write path — throws)", () => {
  it("validateMemory accepts a partial (id-less) memory, rejects bad", () => {
    const { id: _id, ...partial } = memory();
    expect(() => validateMemory(partial)).not.toThrow();
    expect(() => validateMemory({ type: "posted" })).toThrow();
  });

  it("validateRelationshipUpdate enforces bounded sentimentChange", () => {
    expect(() => validateRelationshipUpdate({ sentimentChange: 0.5 })).not.toThrow();
    expect(() => validateRelationshipUpdate({ sentimentChange: 9 })).toThrow();
    expect(() => validateRelationshipUpdate({})).toThrow();
  });
});
