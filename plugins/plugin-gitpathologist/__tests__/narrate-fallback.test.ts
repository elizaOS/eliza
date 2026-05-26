import { describe, expect, it } from "vitest";
import { buildFallbackCauses, categoryFromFlags, fallbackRotCause } from "../src/pipeline/narrate-fallback.ts";
import type { CommitHealthPoint, InflectionPoint } from "../src/types.ts";

function point(overrides: Partial<CommitHealthPoint>): CommitHealthPoint {
  return {
    sha: "0000000000000000000000000000000000000000",
    parents: [],
    author: "alice",
    authorEmail: "alice@example.com",
    date: "2026-04-01T10:00:00Z",
    subject: "x",
    body: "",
    files: [],
    diffSnippet: "",
    type: "other",
    riskFlags: [],
    classifiedBy: "rule",
    delta: 0,
    score: 0,
    churn: 0,
    ...overrides,
  };
}

function inflection(sha: string): InflectionPoint {
  return {
    sha,
    date: "2026-04-01T10:00:00Z",
    author: "alice",
    score: -0.5,
    delta: -0.5,
    reasonShort: "drift",
  };
}

describe("categoryFromFlags", () => {
  it("prioritizes later-reverted as revert-cycle", () => {
    expect(categoryFromFlags(point({ riskFlags: ["later-reverted"] }))).toBe("revert-cycle");
  });
  it("merge with high churn → bad-merge", () => {
    expect(categoryFromFlags(point({ type: "merge", churn: 300 }))).toBe("bad-merge");
  });
  it("wip-message → rushed-fix", () => {
    expect(categoryFromFlags(point({ riskFlags: ["wip-message"] }))).toBe("rushed-fix");
  });
  it("wide-blast → scope-creep", () => {
    expect(categoryFromFlags(point({ riskFlags: ["wide-blast"] }))).toBe("scope-creep");
  });
  it("large-churn (and no other signal) → churn-spiral", () => {
    expect(categoryFromFlags(point({ riskFlags: ["large-churn"] }))).toBe("churn-spiral");
  });
  it("nothing notable → other", () => {
    expect(categoryFromFlags(point({}))).toBe("other");
  });
});

describe("fallbackRotCause", () => {
  it("uses drift commit as start of shaRange and last after-commit as end", () => {
    const drift = point({ sha: "aaa".padEnd(40, "0") });
    const before = [point({ sha: "bbb".padEnd(40, "0") })];
    const after = [
      point({ sha: "ccc".padEnd(40, "0") }),
      point({ sha: "ddd".padEnd(40, "0") }),
    ];
    const cause = fallbackRotCause(drift, before, after);
    expect(cause.shaRange[0]).toBe(drift.sha);
    expect(cause.shaRange[1]).toBe(after[after.length - 1]?.sha);
    expect(cause.evidence).toContain(drift.sha);
    expect(cause.evidence).toContain(before[0]?.sha);
    expect(cause.narrative).toContain("Heuristic match");
  });
});

describe("buildFallbackCauses", () => {
  it("emits one cause per drift (no budget gating in fallback path)", () => {
    const timeline = [
      point({ sha: "aaa".padEnd(40, "0") }),
      point({ sha: "bbb".padEnd(40, "0") }),
      point({ sha: "ccc".padEnd(40, "0") }),
      point({ sha: "ddd".padEnd(40, "0") }),
    ];
    const drifts = [inflection("bbb".padEnd(40, "0")), inflection("ccc".padEnd(40, "0"))];
    const causes = buildFallbackCauses({ timeline, drifts });
    expect(causes.length).toBe(2);
  });

  it("skips drifts that do not appear in the timeline", () => {
    const timeline = [point({ sha: "aaa".padEnd(40, "0") })];
    const drifts = [inflection("missing".padEnd(40, "0"))];
    expect(buildFallbackCauses({ timeline, drifts })).toEqual([]);
  });
});
