import { describe, expect, it } from "vitest";
import { queryPastExperience } from "../../src/services/trajectory-feedback";

/**
 * Per-trajectory insight budget regression (audit-2 #7).
 *
 * The fast path (pre-extracted metadata insights) has always capped at 50
 * insights per trajectory via `.slice(0, 50)`. The slow-path detail scan
 * (legacy trajectories with no metadata insights) previously had NO such cap,
 * so a single trajectory with many steps/LLM calls could balloon the
 * intermediate `experiences` array before the final dedup + `maxEntries` cap.
 * These tests pin BOTH paths to the same 50/trajectory budget.
 */

const MAX = 50;

type Summary = {
  id: string;
  source: string;
  startTime: number;
  llmCallCount: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

function makeRuntime(logger: unknown) {
  return {
    getService: (type: string) => (type === "trajectories" ? logger : null),
  } as unknown as Parameters<typeof queryPastExperience>[0];
}

/** A trajectory logger whose single trajectory drives the SLOW path (no
 * metadata insights), returning a detail with `decisionCount` unique
 * `DECISION:` lines in one LLM response. */
function slowPathLogger(decisionCount: number) {
  const summary: Summary = {
    id: "traj-slow",
    source: "orchestrator",
    startTime: 1_000,
    llmCallCount: 1,
    createdAt: new Date(1_000).toISOString(),
    // No metadata.insights → forces the slow path.
    metadata: { orchestrator: { decisionType: "coordination" } },
  };
  const response = Array.from(
    { length: decisionCount },
    (_, i) => `DECISION: unique slow-path insight number ${i}`,
  ).join("\n");
  return {
    listTrajectories: async () => ({ trajectories: [summary], total: 1 }),
    getTrajectoryDetail: async () => ({
      trajectoryId: "traj-slow",
      steps: [{ llmCalls: [{ purpose: "coordination", response }] }],
    }),
  };
}

/** A trajectory logger whose single trajectory drives the FAST path
 * (pre-extracted metadata insights). */
function fastPathLogger(insightCount: number) {
  const summary: Summary = {
    id: "traj-fast",
    source: "orchestrator",
    startTime: 2_000,
    llmCallCount: 0,
    createdAt: new Date(2_000).toISOString(),
    metadata: {
      orchestrator: { decisionType: "coordination" },
      insights: Array.from(
        { length: insightCount },
        (_, i) => `unique fast-path insight number ${i}`,
      ),
    },
  };
  return {
    listTrajectories: async () => ({ trajectories: [summary], total: 1 }),
    getTrajectoryDetail: async () => null,
  };
}

describe("queryPastExperience per-trajectory insight cap (audit-2 #7)", () => {
  it("caps the SLOW path at 50 insights from a single trajectory", async () => {
    // 120 unique decisions in one trajectory; maxEntries is set high so the
    // per-trajectory cap — not the final cap — is what limits the result.
    const runtime = makeRuntime(slowPathLogger(120));
    const result = await queryPastExperience(runtime, { maxEntries: 1_000 });
    expect(result.length).toBe(MAX);
  });

  it("caps the FAST path at 50 insights from a single trajectory", async () => {
    const runtime = makeRuntime(fastPathLogger(120));
    const result = await queryPastExperience(runtime, { maxEntries: 1_000 });
    expect(result.length).toBe(MAX);
  });

  it("returns all insights when a trajectory is under the cap", async () => {
    const runtime = makeRuntime(slowPathLogger(10));
    const result = await queryPastExperience(runtime, { maxEntries: 1_000 });
    expect(result.length).toBe(10);
  });
});
