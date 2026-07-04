/** Tests the `reminderIntensity` final check (final-checks/index.ts) with LifeOpsService and reminder-preference state mocked, asserting reminder lifecycle metadata is read and the intensity expectation is enforced. */
import type { IAgentRuntime } from "@elizaos/core";
import { REMINDER_LIFECYCLE_METADATA_KEY } from "@elizaos/plugin-personal-assistant/lifeops/service-constants";
import type { ScenarioFinalCheck } from "@elizaos/scenario-runner/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLifeOpsState = vi.hoisted(() => ({
  definitions: [] as unknown[],
  preference: null as unknown,
}));

vi.mock("@elizaos/plugin-personal-assistant/lifeops/service", () => ({
  LifeOpsService: class {
    async listDefinitions(): Promise<unknown[]> {
      return mockLifeOpsState.definitions;
    }

    async getReminderPreference(): Promise<unknown> {
      return mockLifeOpsState.preference;
    }
  },
}));

const { runFinalCheck } = await import("./index.ts");

const runtime = {} as IAgentRuntime;

describe("reminderIntensity final check", () => {
  beforeEach(() => {
    mockLifeOpsState.definitions = [];
    mockLifeOpsState.preference = null;
  });

  it("passes when a matching reminder preference stores the expected intensity", async () => {
    mockLifeOpsState.definitions = [
      {
        definition: {
          id: "definition-brush-teeth",
          title: "Brush teeth",
        },
      },
    ];
    mockLifeOpsState.preference = {
      effective: {
        intensity: "minimal",
      },
    };

    const report = await runFinalCheck(
      {
        type: "reminderIntensity",
        title: "brush teeth",
        expected: "minimal",
      } satisfies ScenarioFinalCheck,
      {
        runtime,
        ctx: {
          actionsCalled: [],
        },
      },
    );

    expect(report.status).toBe("passed");
    expect(report.detail).toContain("effective intensity=minimal");
  });

  it("fails when the stored reminder preference has a different intensity", async () => {
    mockLifeOpsState.definitions = [
      {
        definition: {
          id: "definition-brush-teeth",
          title: "Brush teeth",
        },
      },
    ];
    mockLifeOpsState.preference = {
      effective: {
        intensity: "normal",
      },
    };

    const report = await runFinalCheck(
      {
        type: "reminderIntensity",
        title: "Brush teeth",
        expected: "minimal",
      } satisfies ScenarioFinalCheck,
      {
        runtime,
        ctx: {
          actionsCalled: [],
        },
      },
    );

    expect(report.status).toBe("failed");
    expect(report.detail).toContain("saw normal");
  });

  it("passes escalated when captured turn bodies include a delivered escalation attempt", async () => {
    const report = await runFinalCheck(
      {
        type: "reminderIntensity",
        title: "Call dentist",
        expected: "escalated",
      } satisfies ScenarioFinalCheck,
      {
        runtime,
        ctx: {
          actionsCalled: [],
          turns: [
            {
              actionsCalled: [],
              responseBody: {
                attempts: [
                  {
                    outcome: "delivered",
                    deliveryMetadata: {
                      title: "Call dentist",
                      [REMINDER_LIFECYCLE_METADATA_KEY]: "escalation",
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    );

    expect(report.status).toBe("passed");
    expect(report.detail).toContain("delivered escalation");
  });

  it("fails escalated when no delivered escalation attempt matches the title", async () => {
    const report = await runFinalCheck(
      {
        type: "reminderIntensity",
        title: "Call dentist",
        expected: "escalated",
      } satisfies ScenarioFinalCheck,
      {
        runtime,
        ctx: {
          actionsCalled: [],
          turns: [
            {
              actionsCalled: [],
              responseBody: {
                attempts: [
                  {
                    outcome: "delivered",
                    deliveryMetadata: {
                      title: "Drink water",
                      [REMINDER_LIFECYCLE_METADATA_KEY]: "escalation",
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    );

    expect(report.status).toBe("failed");
    expect(report.detail).toContain("no delivered escalation");
  });
});
