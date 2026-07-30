/** Tests final-check routing and trusted-observation matching against bounded in-memory contexts. */
import { createHash } from "node:crypto";
import type {
  ScenarioContext,
  ScenarioFinalCheck,
} from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import type { ScenarioEvidenceReport } from "../types.ts";
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function providerEvidence(): ScenarioEvidenceReport {
  const trajectorySha256 = sha256("trajectory");
  return {
    schemaVersion: 1,
    executionProfile: "provider-qualified",
    qualification: {
      status: "qualified",
      publishable: true,
      reasons: [],
    },
    observerProvenance: [
      {
        observerId: "calendar-observer",
        kind: "provider-api",
        implementation: "calendar-readback",
        version: "1.0.0",
        environment: "sandbox",
        configurationSha256: sha256("configuration"),
      },
    ],
    trajectoryHashes: [
      {
        trajectoryId: "trajectory-1",
        relativePath: "trajectories/trajectory-1.json",
        sha256: trajectorySha256,
        recorder: {
          implementation: "trajectory-recorder",
          version: "1.0.0",
          environment: "sandbox",
        },
      },
    ],
    observations: [
      {
        observationId: "observation-1",
        kind: "provider-effect",
        observedAtIso: "2026-07-28T12:00:01.000Z",
        observerId: "calendar-observer",
        source: {
          kind: "provider-api",
          system: "google-calendar",
          environment: "sandbox",
          recordIdSha256: sha256("event-1"),
          accountRefSha256: sha256("parent-account"),
        },
        payloadSha256: sha256("payload"),
        trajectoryRefs: [
          {
            trajectoryId: "trajectory-1",
            stageId: "stage-1",
            sha256: trajectorySha256,
          },
        ],
        provider: "google-calendar",
        operation: "create",
        accountRefSha256: sha256("parent-account"),
        requestSha256: sha256("request"),
        responseSha256: sha256("response"),
        providerReceiptIdSha256: sha256("event-1"),
        readbackSha256: sha256("readback"),
      },
      {
        observationId: "observation-2",
        kind: "provider-no-effect",
        observedAtIso: "2026-07-28T12:00:02.000Z",
        observerId: "calendar-observer",
        source: {
          kind: "provider-api",
          system: "google-calendar",
          environment: "sandbox",
          recordIdSha256: sha256("calendar-scope"),
          accountRefSha256: sha256("parent-account"),
        },
        payloadSha256: sha256("no-effect-payload"),
        trajectoryRefs: [
          {
            trajectoryId: "trajectory-1",
            stageId: "stage-1",
            sha256: trajectorySha256,
          },
        ],
        provider: "google-calendar",
        accountRefSha256: sha256("parent-account"),
        effectKinds: ["delete"],
        scopeSha256: sha256("calendar-scope"),
        beforeSnapshotSha256: sha256("snapshot"),
        afterSnapshotSha256: sha256("snapshot"),
        observationStartedAtIso: "2026-07-28T11:59:59.000Z",
        observationEndedAtIso: "2026-07-28T12:00:03.000Z",
      },
    ],
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

describe("trusted observation finalChecks", () => {
  it("matches provider effects by plaintext filters against hashed external identities", async () => {
    await expect(
      runFinalCheck(
        {
          type: "providerEffectObserved",
          observerId: "calendar-observer",
          provider: "google-calendar",
          accountId: "parent-account",
          operation: "create",
          resourceId: "event-1",
        },
        {
          runtime,
          ctx: createContext(),
          trustedEvidence: providerEvidence(),
          scenarioStartedAtIso: "2026-07-28T12:00:00.000Z",
          scenarioEndedAtIso: "2026-07-28T12:00:02.000Z",
        },
      ),
    ).resolves.toMatchObject({
      type: "providerEffectObserved",
      status: "passed",
    });
  });

  it("requires a no-effect observer interval to cover the scenario", async () => {
    const context = {
      runtime,
      ctx: createContext(),
      trustedEvidence: providerEvidence(),
      scenarioStartedAtIso: "2026-07-28T12:00:00.000Z",
      scenarioEndedAtIso: "2026-07-28T12:00:02.000Z",
    };
    await expect(
      runFinalCheck(
        {
          type: "providerNoEffectObserved",
          provider: "google-calendar",
          resourceId: "calendar-scope",
        },
        context,
      ),
    ).resolves.toMatchObject({ status: "passed" });

    await expect(
      runFinalCheck(
        {
          type: "providerNoEffectObserved",
          provider: "google-calendar",
        },
        {
          ...context,
          scenarioStartedAtIso: "2026-07-28T11:00:00.000Z",
        },
      ),
    ).resolves.toMatchObject({
      status: "failed",
      detail: expect.stringContaining("saw 0"),
    });
  });

  it("skips rather than inferring trusted evidence from captured action results", async () => {
    await expect(
      runFinalCheck(
        { type: "providerEffectObserved", provider: "google-calendar" },
        {
          runtime,
          ctx: createContext({
            actionsCalled: [
              {
                actionName: "CALENDAR",
                result: {
                  success: true,
                  data: { providerReceiptId: "invented-action-payload" },
                },
              },
            ],
          }),
        },
      ),
    ).resolves.toMatchObject({
      status: "skipped",
      detail: expect.stringContaining("not accepted as substitutes"),
    });
  });
});

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
