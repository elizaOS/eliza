/** Schema-rejected drafts cannot override the same turn's receipt-grounded completion. */
import type {
  Action,
  IAgentRuntime,
  Memory,
  PlannerToolResult,
} from "@elizaos/core";
import { executePlannedToolCall } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { runPlannerLoop } from "./planner-loop.ts";

const corrected = {
  details: { attendees: [{ email: "user@example.com" }], durationMinutes: 15 },
};
const invalid = {
  details: {
    ...corrected.details,
    sourceNote: {
      noteId: "note-test",
      agentId: "alpha",
      contentHash: "abcd".repeat(18),
    },
  },
};
const applied: PlannerToolResult = {
  success: true,
  turnComplete: false,
  modelReplyRequired: true,
  transcriptVisibility: "internal",
  data: { actionName: "CALENDAR_CREATE_EVENT" },
  effectReceipts: [
    {
      receiptId: "calendar-created",
      operation: "calendar.event.create",
      resource: {
        kind: "calendar.event",
        id: "event-test",
        version: '"eliza-1"',
      },
      artifacts: [],
      idempotency: { key: "calendar-create-test", replayed: false },
      observedAt: "2026-10-27T08:40:36.881Z",
      outcome: "applied",
      commit: {
        kind: "durable",
        id: "event-test",
        committedAt: "2026-10-27T08:40:36.881Z",
      },
    },
  ],
};
const confirmation =
  "Done — Calendar check is on your calendar for tomorrow, Wednesday Oct 28, 3:00–3:15 PM PDT.";
async function schemaRejection() {
  const handler = vi.fn(async () => applied);
  const action = {
    name: "CALENDAR_CREATE_EVENT",
    description: "Create event",
    similes: [],
    examples: [],
    handler,
    parameters: [
      {
        name: "details",
        description: "Event details",
        required: false,
        schema: {
          type: "object",
          properties: {
            attendees: {
              type: "array",
              items: {
                type: "object",
                properties: { email: { type: "string" } },
              },
            },
            durationMinutes: { type: "number" },
            sourceNote: {
              type: "object",
              properties: {
                noteId: { type: "string" },
                agentId: { type: "string" },
                contentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
              },
            },
          },
        },
      },
    ],
  } as Action;
  const runtime = {
    actions: [action],
    getSetting: () => undefined,
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  } as unknown as IAgentRuntime;
  const result = await executePlannedToolCall(
    runtime,
    {
      message: {
        id: "11111111-1111-4111-8111-111111111111",
        entityId: "22222222-2222-4222-8222-222222222222",
        roomId: "33333333-3333-4333-8333-333333333333",
        content: {
          text: "Put a 15-minute Calendar check on my calendar tomorrow at 3 pm.",
        },
      } as Memory,
      userRoles: ["OWNER"],
      entityAliases: {},
    },
    { name: action.name, params: invalid },
  );
  expect(handler).not.toHaveBeenCalled();
  expect(result.success).toBe(false);
  expect(result.data?.invalidParameterNames).toEqual(["details"]);
  return result;
}

describe("schema-gate recovery finalization", () => {
  it("marks the exact nested argument rejection as retryable and not started", async () => {
    const result = await schemaRejection();
    expect(result.data).toMatchObject({
      acceptance: "rejected",
      executionStatus: "not_started",
    });
    expect(result.failureProvenance).toMatchObject({
      retryable: true,
      code: "ACTION_ARGUMENTS_INVALID",
    });
    expect(result.effectReceipts?.length ?? 0).toBe(0);
  });
  it("retains the applied evaluator reply after the corrected Calendar create without a third plan", async () => {
    const rejected = await schemaRejection();
    let calls = 0,
      writes = 0;
    const result = await runPlannerLoop({
      codingMode: false,
      context: {
        id: "calendar-schema-recovery",
        events: [
          {
            id: "stage1-declared-intents",
            type: "instruction",
            content: "- Create Calendar check",
          },
        ],
      },
      runtime: {
        useModel: async () => {
          calls++;
          if (calls <= 2)
            return {
              text: "",
              toolCalls: [
                {
                  id: `create-${calls}`,
                  name: "CALENDAR_CREATE_EVENT",
                  arguments: {
                    ...(calls === 1 ? invalid : corrected),
                    eliza_turn_scope: "final",
                  },
                },
              ],
            };
          return {
            text: JSON.stringify({
              completed: true,
              toolCalls: [],
              messageToUser:
                "The earlier internal reference was invalid, so I could not create the event.",
            }),
          };
        },
      },
      evaluate: async ({ trajectory }) =>
        trajectory.steps.at(-1)?.result?.success === false
          ? {
              decision: "CONTINUE",
              success: false,
              thought: "Fixture validation rejected.",
              messageToUser: "",
              outcomeCoverage: [
                {
                  intentId: "intent:1",
                  status: "pending",
                  evidenceStepIds: [],
                },
              ],
              effectReceiptIds: [],
              replyEffectStatus: "non_applied",
              requestFullyCovered: false,
            }
          : {
              decision: "FINISH",
              success: true,
              thought: "Fixture receipt confirms completion.",
              messageToUser: confirmation,
              outcomeCoverage: [
                {
                  intentId: "intent:1",
                  status: "completed",
                  evidenceStepIds: ["step:2"],
                },
              ],
              effectReceiptIds: ["calendar-created"],
              replyEffectStatus: "applied",
              requestFullyCovered: true,
            },
      executeToolCall: async () => {
        if (writes++ === 0) return rejected;
        return applied;
      },
    });
    expect(result.evaluator?.success).toBe(true);
    expect(result.finalMessage).toBe(confirmation);
    expect(calls).toBe(2);
    expect(writes).toBe(2);
    expect(
      result.trajectory.steps.filter((s) => s.result?.success === false),
    ).toHaveLength(1);
    expect(
      result.trajectory.steps.filter((s) =>
        s.result?.effectReceipts?.some((r) => r.outcome === "applied"),
      ),
    ).toHaveLength(1);
  });
  it.each(["unknown_execution", "nonretryable", "failed_effect"] as const)(
    "keeps %s failures authoritative after a different committed result",
    async (scenario) => {
      const rejected = await schemaRejection();
      const failure: PlannerToolResult = {
        ...rejected,
        data: {
          ...rejected.data,
          executionStatus:
            scenario === "unknown_execution" ? "unknown" : "not_started",
        },
        failureProvenance: {
          kind: "handler_error",
          boundary: "handler",
          code: "FIXTURE_FAILURE",
          retryable: scenario !== "nonretryable",
        },
        ...(scenario === "failed_effect"
          ? {
              effectReceipts: [
                {
                  receiptId: "different-event-failed",
                  operation: "calendar.event.create",
                  resource: { kind: "calendar.event", id: "different-event" },
                  artifacts: [],
                  idempotency: { key: "different-event", replayed: false },
                  observedAt: "2026-10-27T08:40:35.000Z",
                  outcome: "failed" as const,
                  failure: {
                    code: "PROVIDER_OUTCOME_UNKNOWN",
                    retryable: false,
                    acceptance: "unknown" as const,
                  },
                },
              ],
            }
          : {}),
      };
      let plans = 0,
        attempts = 0;
      const result = await runPlannerLoop({
        codingMode: false,
        context: {
          id: "failed-calendar-outcome",
          events: [
            {
              id: "stage1-declared-intents",
              type: "instruction",
              content: "- Create Calendar check",
            },
          ],
        },
        runtime: {
          useModel: async () => {
            plans++;
            return plans <= 2
              ? {
                  text: "",
                  toolCalls: [
                    {
                      id: `attempt-${plans}`,
                      name: "CALENDAR_CREATE_EVENT",
                      arguments: {
                        ...(plans === 1 ? invalid : corrected),
                        eliza_turn_scope: "final",
                      },
                    },
                  ],
                }
              : {
                  text: JSON.stringify({
                    completed: true,
                    toolCalls: [],
                    messageToUser:
                      "One attempt failed. I cannot confirm the whole request completed.",
                  }),
                };
          },
        },
        executeToolCall: async () => (attempts++ === 0 ? failure : applied),
        evaluate: async ({ trajectory }) =>
          trajectory.steps.at(-1)?.result?.success === false
            ? {
                decision: "CONTINUE",
                success: false,
                thought: "Fixture rejected.",
                messageToUser: "",
              }
            : {
                decision: "FINISH",
                success: true,
                thought: "Fixture claimed completion.",
                messageToUser: confirmation,
                effectReceiptIds: ["calendar-created"],
                replyEffectStatus: "applied",
                requestFullyCovered: true,
                outcomeCoverage: [
                  {
                    intentId: "intent:1",
                    status: "completed",
                    evidenceStepIds: ["step:2"],
                  },
                ],
              },
      });
      expect(plans).toBeGreaterThan(2);
      expect(result.finalMessage).not.toBe(confirmation);
      expect(
        result.trajectory.steps.some((step) => step.result?.success === false),
      ).toBe(true);
    },
  );
});
