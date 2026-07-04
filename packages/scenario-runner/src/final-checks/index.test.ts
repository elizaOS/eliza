/** Tests the final-check dispatcher `runFinalCheck` (final-checks/index.ts): routing to the right handler by check `type` and the unknown-type/error behavior, against a synthetic context. */
import type {
  ScenarioContext,
  ScenarioFinalCheck,
} from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import { type FinalCheckRuntime, runFinalCheck } from "./index";

const runtime: FinalCheckRuntime = {};

function createContext(
  overrides: Partial<ScenarioContext> = {},
): ScenarioContext {
  return {
    actionsCalled: [],
    memoryWrites: [],
    ...overrides,
  };
}

function runtimeWithTrajectoryService(
  details: Record<
    string,
    {
      scenarioId?: string;
      steps?: Array<{
        llmCalls?: Array<{
          purpose?: string;
          userPrompt?: string;
          response?: string;
        }>;
      }>;
    }
  >,
): FinalCheckRuntime {
  const service = {
    async listTrajectories(options?: { scenarioId?: string }) {
      return {
        trajectories: Object.entries(details)
          .filter(
            ([, detail]) =>
              !options?.scenarioId || detail.scenarioId === options.scenarioId,
          )
          .map(([id, detail]) => ({
            id,
            scenarioId: detail.scenarioId,
          })),
      };
    },
    async getTrajectoryDetail(id: string) {
      return details[id]
        ? {
            trajectoryId: id,
            ...details[id],
          }
        : null;
    },
  };

  return {
    getService(name: string) {
      return name === "trajectories" ? service : null;
    },
  };
}

describe("modelCallOccurred finalCheck", () => {
  it("passes when a matching scenario trajectory contains the requested purpose", async () => {
    const result = await runFinalCheck(
      {
        type: "modelCallOccurred",
        purpose: "schedule_plan",
      } as ScenarioFinalCheck,
      {
        runtime: runtimeWithTrajectoryService({
          "traj-1": {
            scenarioId: "schedule-plan-capability",
            steps: [
              {
                llmCalls: [
                  {
                    purpose: "schedule_plan",
                    userPrompt: "Plan the scheduling negotiation.",
                    response: '{"subaction":"start"}',
                  },
                ],
              },
            ],
          },
        }),
        ctx: createContext({ scenarioId: "schedule-plan-capability" }),
      },
    );

    expect(result).toMatchObject({
      type: "modelCallOccurred",
      status: "passed",
    });
    expect(result.detail).toContain("schedule_plan");
  });

  it("fails when the scenario trajectory has no matching model-call purpose", async () => {
    const result = await runFinalCheck(
      {
        type: "modelCallOccurred",
        purpose: "inbox_triage",
      } as ScenarioFinalCheck,
      {
        runtime: runtimeWithTrajectoryService({
          "traj-1": {
            scenarioId: "inbox-triage-capability",
            steps: [{ llmCalls: [{ purpose: "action" }] }],
          },
        }),
        ctx: createContext({ scenarioId: "inbox-triage-capability" }),
      },
    );

    expect(result).toMatchObject({
      type: "modelCallOccurred",
      status: "failed",
    });
    expect(result.detail).toContain("Observed purposes: action");
  });

  it("waits for async trajectory writes before deciding the model call is missing", async () => {
    let detailReads = 0;
    const runtimeWithDelayedTrajectory: FinalCheckRuntime = {
      getService(name: string) {
        if (name !== "trajectories") return null;
        return {
          async listTrajectories() {
            return {
              trajectories: [
                {
                  id: "traj-1",
                  scenarioId: "inbox-triage-capability",
                },
              ],
            };
          },
          async flushWriteQueue() {
            return undefined;
          },
          async getTrajectoryDetail(id: string) {
            detailReads += 1;
            if (detailReads === 1) {
              return {
                trajectoryId: id,
                scenarioId: "inbox-triage-capability",
                steps: [],
              };
            }
            return {
              trajectoryId: id,
              scenarioId: "inbox-triage-capability",
              steps: [
                {
                  llmCalls: [
                    {
                      purpose: "inbox_triage",
                      userPrompt: "Classify each message.",
                    },
                  ],
                },
              ],
            };
          },
        };
      },
    };

    const result = await runFinalCheck(
      {
        type: "modelCallOccurred",
        purpose: "inbox_triage",
      } as ScenarioFinalCheck,
      {
        runtime: runtimeWithDelayedTrajectory,
        ctx: createContext({ scenarioId: "inbox-triage-capability" }),
      },
    );

    expect(result).toMatchObject({
      type: "modelCallOccurred",
      status: "passed",
    });
    expect(detailReads).toBeGreaterThan(1);
  });

  it("fails loudly when no trajectory service is registered", async () => {
    const result = await runFinalCheck(
      {
        type: "modelCallOccurred",
        purpose: "calendar_extract",
      } as ScenarioFinalCheck,
      {
        runtime,
        ctx: createContext({ scenarioId: "calendar-extract-capability" }),
      },
    );

    expect(result).toMatchObject({
      type: "modelCallOccurred",
      status: "failed",
    });
    expect(result.detail).toContain("trajectory service unavailable");
  });
});

describe("memoryExists finalCheck", () => {
  it("passes when a captured memory write matches the requested content", async () => {
    const result = await runFinalCheck(
      {
        type: "memoryExists",
        content: {
          text: { $contains: "submit report" },
        },
      } as ScenarioFinalCheck,
      {
        runtime,
        ctx: createContext({
          memoryWrites: [
            {
              table: "messages",
              content: {
                text: "Added todo: Submit Report.",
              },
            },
          ],
        }),
      },
    );

    expect(result).toMatchObject({
      type: "memoryExists",
      status: "passed",
      detail: "1 matching memory write(s)",
    });
  });

  it("fails when no captured memory write matches the requested content", async () => {
    const result = await runFinalCheck(
      {
        type: "memoryExists",
        content: {
          text: { $contains: "timesheet" },
        },
      } as ScenarioFinalCheck,
      {
        runtime,
        ctx: createContext({
          memoryWrites: [
            {
              table: "messages",
              content: {
                text: "Added todo: Submit Report.",
              },
            },
          ],
        }),
      },
    );

    expect(result).toMatchObject({
      type: "memoryExists",
      status: "failed",
      detail: "expected 1 matching memory write(s), saw 0 of 1 total",
    });
  });

  it("supports table filters, minCount, and negative checks", async () => {
    const ctx = createContext({
      memoryWrites: [
        { table: "messages", content: { text: "take vitamins" } },
        { table: "messages", content: { text: "vitamins overdue" } },
        { table: "facts", content: { text: "vitamins" } },
      ],
    });

    await expect(
      runFinalCheck(
        {
          type: "memoryExists",
          table: "messages",
          content: { text: { $contains: "vitamins" } },
          minCount: 2,
        } as ScenarioFinalCheck,
        { runtime, ctx },
      ),
    ).resolves.toMatchObject({ status: "passed" });

    await expect(
      runFinalCheck(
        {
          type: "memoryExists",
          table: "messages",
          content: { text: { $contains: /vitamins/g } },
          minCount: 2,
        } as ScenarioFinalCheck,
        { runtime, ctx },
      ),
    ).resolves.toMatchObject({ status: "passed" });

    await expect(
      runFinalCheck(
        {
          type: "memoryExists",
          table: "messages",
          content: { text: { $contains: "deleted" } },
          expected: false,
        } as ScenarioFinalCheck,
        { runtime, ctx },
      ),
    ).resolves.toMatchObject({ status: "passed" });
  });
});
