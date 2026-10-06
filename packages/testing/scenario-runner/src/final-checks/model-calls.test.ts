import { expect, it, vi } from "vitest";
import { runFinalCheck } from "./index.ts";

it("finds a model call beyond the recent trajectory page", async () => {
  const listTrajectories = vi
    .fn()
    .mockResolvedValueOnce({
      trajectories: Array.from({ length: 100 }, (_, index) => ({
        id: String(index),
      })),
    })
    .mockResolvedValueOnce({ trajectories: [{ id: "older" }] });
  const service = {
    listTrajectories,
    getTrajectoryDetail: async (id: string) => ({
      scenarioId: "scope",
      steps: [{ llmCalls: id === "older" ? [{ purpose: "requested" }] : [] }],
    }),
  };
  const result = await runFinalCheck(
    { type: "modelCallOccurred", purpose: "requested" },
    {
      runtime: { getService: () => service },
      ctx: { scenarioId: "scope", actionsCalled: [] },
    },
  );
  expect(result.status).toBe("passed");
  expect(listTrajectories).toHaveBeenLastCalledWith({
    limit: 100,
    offset: 100,
    scenarioId: "scope",
  });
});

it("does not hide a failed trajectory flush as evidence of success", async () => {
  const service = {
    listTrajectories: async () => ({ trajectories: [{ id: "one" }] }),
    getTrajectoryDetail: async () => ({
      steps: [{ llmCalls: [{ purpose: "requested" }] }],
    }),
    flushWriteQueue: async () => {
      throw new Error("persistence failed");
    },
  };
  await expect(
    runFinalCheck(
      { type: "modelCallOccurred" },
      { runtime: { getService: () => service }, ctx: { actionsCalled: [] } },
    ),
  ).rejects.toThrow("persistence failed");
});
