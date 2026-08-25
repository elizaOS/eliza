/**
 * Complete trajectory-feedback traversal regression.
 *
 * The deterministic logger doubles prove both metadata and legacy detail paths
 * preserve every insight even when legacy page-size options request less.
 */

import { describe, expect, it } from "vitest";
import { queryPastExperience } from "../../src/services/trajectory-feedback";

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

describe("queryPastExperience complete traversal", () => {
  it("preserves every SLOW-path insight from a single trajectory", async () => {
    const runtime = makeRuntime(slowPathLogger(120));
    const result = await queryPastExperience(runtime, { maxEntries: 1 });
    expect(result).toHaveLength(120);
    expect(result[0]?.insight).toBe("unique slow-path insight number 0");
    expect(result[119]?.insight).toBe("unique slow-path insight number 119");
  });

  it("preserves every FAST-path insight from a single trajectory", async () => {
    const runtime = makeRuntime(fastPathLogger(120));
    const result = await queryPastExperience(runtime, { maxEntries: 1 });
    expect(result).toHaveLength(120);
  });

  it("returns all insights when a trajectory is under the cap", async () => {
    const runtime = makeRuntime(slowPathLogger(10));
    const result = await queryPastExperience(runtime, { maxEntries: 1_000 });
    expect(result.length).toBe(10);
  });

  it("preserves duplicate records in source order", async () => {
    const runtime = makeRuntime({
      listTrajectories: async () => ({
        trajectories: [
          {
            id: "first",
            source: "orchestrator",
            startTime: 2,
            llmCallCount: 0,
            createdAt: new Date(2).toISOString(),
            metadata: { insights: ["Same", "Same"] },
          },
          {
            id: "second",
            source: "orchestrator",
            startTime: 1,
            llmCallCount: 0,
            createdAt: new Date(1).toISOString(),
            metadata: { insights: ["older"] },
          },
        ],
        total: 2,
      }),
      getTrajectoryDetail: async () => null,
    });

    const result = await queryPastExperience(runtime, {
      taskDescription: "unrelated filter",
    });
    expect(result.map((entry) => entry.insight)).toEqual([
      "Same",
      "Same",
      "older",
    ]);
  });

  it("preserves whitespace and long reasoning exactly", async () => {
    const exactMetadata = "  metadata insight  ";
    const longReasoning = `${"reasoning ".repeat(40)}  `;
    const runtime = makeRuntime({
      listTrajectories: async () => ({
        trajectories: [
          {
            id: "metadata",
            source: "orchestrator",
            startTime: 2,
            llmCallCount: 0,
            createdAt: new Date(2).toISOString(),
            metadata: { insights: [exactMetadata] },
          },
          {
            id: "legacy",
            source: "orchestrator",
            startTime: 1,
            llmCallCount: 1,
            createdAt: new Date(1).toISOString(),
          },
        ],
        total: 2,
      }),
      getTrajectoryDetail: async (id: string) =>
        id === "legacy"
          ? {
              trajectoryId: id,
              steps: [
                {
                  llmCalls: [
                    {
                      purpose: "coordination",
                      response: JSON.stringify({ reasoning: longReasoning }),
                    },
                  ],
                },
              ],
            }
          : null,
    });

    const result = await queryPastExperience(runtime);
    expect(result.map((entry) => entry.insight)).toEqual([
      exactMetadata,
      longReasoning,
    ]);
  });

  it("rejects malformed stored insight text explicitly", async () => {
    const runtime = makeRuntime({
      listTrajectories: async () => ({
        trajectories: [
          {
            id: "malformed",
            source: "orchestrator",
            startTime: 1,
            llmCallCount: 0,
            createdAt: new Date(1).toISOString(),
            metadata: { insights: ["bad\ud800insight"] },
          },
        ],
        total: 1,
      }),
      getTrajectoryDetail: async () => null,
    });

    await expect(queryPastExperience(runtime)).rejects.toMatchObject({
      code: "TRAJECTORY_EXPERIENCE_MALFORMED_UNICODE",
    });
  });

  it.each([
    ["missing detail", null, "detail_missing"],
    ["missing steps", { trajectoryId: "legacy" }, "steps_missing"],
    [
      "empty steps for a non-empty summary",
      { trajectoryId: "legacy", steps: [] },
      "steps_missing",
    ],
  ])(
    "rejects %s instead of omitting legacy context",
    async (_label, detail, reason) => {
      const runtime = makeRuntime({
        listTrajectories: async () => ({
          trajectories: [
            {
              id: "legacy",
              source: "orchestrator",
              startTime: 1,
              llmCallCount: 1,
              createdAt: new Date(1).toISOString(),
            },
          ],
          total: 1,
        }),
        getTrajectoryDetail: async () => detail,
      });

      await expect(queryPastExperience(runtime)).rejects.toMatchObject({
        code: "TRAJECTORY_EXPERIENCE_DETAIL_UNAVAILABLE",
        context: { trajectoryId: "legacy", reason },
      });
    },
  );

  it("rejects a partial model-call inventory instead of returning partial context", async () => {
    const runtime = makeRuntime({
      listTrajectories: async () => ({
        trajectories: [
          {
            id: "legacy",
            source: "orchestrator",
            startTime: 1,
            llmCallCount: 2,
            createdAt: new Date(1).toISOString(),
          },
        ],
        total: 1,
      }),
      getTrajectoryDetail: async () => ({
        trajectoryId: "legacy",
        steps: [{ llmCalls: [{ response: "DECISION: only one call" }] }],
      }),
    });

    await expect(queryPastExperience(runtime)).rejects.toMatchObject({
      code: "TRAJECTORY_EXPERIENCE_DETAIL_UNAVAILABLE",
      context: {
        trajectoryId: "legacy",
        reason: "llm_calls_incomplete",
        expectedLlmCallCount: 2,
        observedLlmCallCount: 1,
      },
    });
  });

  it("traverses every storage page without treating page size as a content cap", async () => {
    const summaries = Array.from({ length: 501 }, (_, index) => ({
      id: `trajectory-${index}`,
      source: "orchestrator",
      startTime: 501 - index,
      llmCallCount: 0,
      createdAt: new Date(501 - index).toISOString(),
      metadata: { insights: [`insight-${index}`] },
    }));
    const offsets: number[] = [];
    const runtime = makeRuntime({
      listTrajectories: async (options: {
        offset?: number;
        limit?: number;
      }) => {
        const offset = options.offset ?? 0;
        const limit = options.limit ?? 50;
        offsets.push(offset);
        return {
          trajectories: summaries.slice(offset, offset + limit),
          total: summaries.length,
        };
      },
      getTrajectoryDetail: async () => null,
    });

    const result = await queryPastExperience(runtime, { maxTrajectories: 1 });
    expect(offsets).toEqual([0, 500]);
    expect(result).toHaveLength(501);
    expect(result[500]?.insight).toBe("insight-500");
  });
});
