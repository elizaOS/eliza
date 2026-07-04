/** Tests the `goalCount` final check (final-checks/index.ts) against a synthetic scenario context, asserting the goal tally is compared to the expected bounds. */
import type { IAgentRuntime } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioFinalCheck,
} from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import { runFinalCheck } from "./index";

const runtime = {} as IAgentRuntime;

function createContext(
  overrides: Partial<ScenarioContext> = {},
): ScenarioContext {
  return {
    actionsCalled: [],
    ...overrides,
  };
}

describe("goalCountDelta finalCheck", () => {
  it("passes when a successful action result contains a matching created goal", async () => {
    const result = await runFinalCheck(
      {
        type: "goalCountDelta",
        title: "Ship Eliza v2",
        titleAliases: ["Eliza v2 Q2"],
        delta: 1,
        expectedStatus: "active",
        expectedReviewState: "idle",
        expectedGroundingState: "grounded",
        requireDescription: true,
        requireSuccessCriteria: true,
        requireSupportStrategy: true,
      } as ScenarioFinalCheck,
      {
        runtime,
        ctx: createContext({
          actionsCalled: [
            {
              actionName: "LIFE",
              result: {
                success: true,
                data: {
                  goal: {
                    title: "Ship Eliza v2 by the end of June",
                    description: "Public release with active users.",
                    status: "active",
                    reviewState: "idle",
                    successCriteria: { users: 500 },
                    supportStrategy: { cadence: "weekly" },
                    metadata: { groundingState: "grounded" },
                  },
                },
              },
            },
          ],
        }),
      },
    );

    expect(result).toMatchObject({
      type: "goalCountDelta",
      status: "passed",
      detail: "1 matching goal record(s)",
    });
  });

  it("passes for plugin-goals record wrappers", async () => {
    const result = await runFinalCheck(
      {
        type: "goalCountDelta",
        title: "Family connection",
        titleAliases: ["Stay closer with family"],
        delta: 1,
        expectedStatus: "active",
      } as ScenarioFinalCheck,
      {
        runtime,
        ctx: createContext({
          actionsCalled: [
            {
              actionName: "OWNER_GOALS",
              result: {
                success: true,
                data: {
                  action: "create",
                  record: {
                    goal: {
                      title: "Stay closer with family",
                      status: "active",
                      reviewState: "idle",
                    },
                  },
                },
              },
            },
          ],
        }),
      },
    );

    expect(result).toMatchObject({ status: "passed" });
  });

  it("fails when the matching goal lacks required fields", async () => {
    const result = await runFinalCheck(
      {
        type: "goalCountDelta",
        title: "Stabilize sleep schedule",
        delta: 1,
        requireDescription: true,
        requireSuccessCriteria: true,
      } as ScenarioFinalCheck,
      {
        runtime,
        ctx: createContext({
          actionsCalled: [
            {
              actionName: "LIFE",
              result: {
                success: true,
                data: {
                  goal: {
                    title: "Stabilize sleep schedule",
                    description: "",
                    status: "active",
                    successCriteria: {},
                  },
                },
              },
            },
          ],
        }),
      },
    );

    expect(result).toMatchObject({
      type: "goalCountDelta",
      status: "failed",
      detail:
        "expected 1 matching goal record(s), saw 0. Goal titles: Stabilize sleep schedule",
    });
  });

  it("does not count synthesized replies or failed action results", async () => {
    const result = await runFinalCheck(
      {
        type: "goalCountDelta",
        title: "Lose 10 lbs by June",
        delta: 1,
      } as ScenarioFinalCheck,
      {
        runtime,
        ctx: createContext({
          actionsCalled: [
            {
              actionName: "LIFE",
              result: {
                success: false,
                data: {
                  goal: {
                    title: "Lose 10 lbs by June",
                  },
                },
              },
            },
            {
              actionName: "REPLY",
              result: {
                success: true,
                data: {
                  source: "synthesized-reply",
                  goal: {
                    title: "Lose 10 lbs by June",
                  },
                },
              },
            },
          ],
        }),
      },
    );

    expect(result).toMatchObject({
      status: "failed",
      detail: "expected 1 matching goal record(s), saw 0. Goal titles: (none)",
    });
  });
});
