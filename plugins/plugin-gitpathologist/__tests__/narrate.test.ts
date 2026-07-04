/**
 * Covers the narrate phase: deterministic rot-cause fallback when no model is
 * present, and budget-capped model narration that falls back for drifts beyond
 * budget. The model is a vi.fn stub, not a live LLM.
 */

import { describe, expect, it, vi } from "vitest";
import { narrate } from "../src/pipeline/narrate.ts";
import type { CommitHealthPoint, InflectionPoint } from "../src/types.ts";

function point(
  sha: string,
  score: number,
  delta: number,
  overrides: Partial<CommitHealthPoint> = {}
): CommitHealthPoint {
  return {
    sha: sha.padEnd(40, "0"),
    parents: [],
    author: "alice",
    authorEmail: "alice@example.com",
    date: "2026-04-01T10:00:00Z",
    subject: "change",
    body: "",
    files: [{ path: "src/a.ts", added: 20, deleted: 5, status: "M" }],
    diffSnippet: "",
    type: "other",
    riskFlags: [],
    classifiedBy: "rule",
    delta,
    score,
    churn: 25,
    ...overrides,
  };
}

function driftFor(point: CommitHealthPoint): InflectionPoint {
  return {
    sha: point.sha,
    date: point.date,
    author: point.author,
    score: point.score,
    delta: point.delta,
    reasonShort: "score dropped",
  };
}

describe("narrate", () => {
  it("emits deterministic rot causes when no model is available", async () => {
    const timeline = [
      point("a", 0.3, 0.1),
      point("b", -0.2, -0.5, {
        subject: "revert broken change",
        type: "revert",
      }),
      point("c", -0.3, -0.1),
    ];

    const result = await narrate(null, {
      surfacePath: "src/a.ts",
      repoRoot: "/tmp/missing",
      timeline,
      drifts: [driftFor(timeline[1])],
      budget: 0,
    });

    expect(result.llmCalls).toBe(0);
    expect(result.rotCauses).toHaveLength(1);
    expect(result.rotCauses[0]?.category).toBe("revert-cycle");
    expect(result.rotCauses[0]?.narrative).toContain("deterministic inflection");
  });

  it("uses model narration only within budget and falls back for remaining drifts", async () => {
    const timeline = [
      point("a", 0.3, 0.1),
      point("b", -0.2, -0.5, { churn: 700 }),
      point("c", -0.4, -0.2, { subject: "hotfix production issue" }),
    ];
    const runtime = {
      useModel: vi.fn(async () =>
        JSON.stringify({
          category: "scope-creep",
          narrative: "The model explains this drift with concrete evidence.",
        })
      ),
    };

    const result = await narrate(runtime as never, {
      surfacePath: "src/a.ts",
      repoRoot: "/tmp/missing",
      timeline,
      drifts: [driftFor(timeline[1]), driftFor(timeline[2])],
      budget: 1,
    });

    expect(result.llmCalls).toBe(1);
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(result.rotCauses).toHaveLength(2);
    expect(result.rotCauses[0]?.narrative).toContain("model explains");
    expect(result.rotCauses[1]?.narrative).toContain("deterministic inflection");
  });
});
