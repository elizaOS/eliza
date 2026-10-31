import type { EffectReceipt, PlannerTrajectory } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { runPlannerLoop } from "../planner-loop.ts";

const read: EffectReceipt = {
  receiptId: "feed-read",
  operation: "calendar.event.search",
  resource: { kind: "calendar.feed", id: "feed" },
  artifacts: [],
  idempotency: { key: null, replayed: false },
  observedAt: "2026-10-30T11:35:28.546Z",
  outcome: "noop",
  reason: "Read only",
};
const write: EffectReceipt = {
  receiptId: "event-create",
  operation: "calendar.event.create",
  resource: { kind: "calendar.event", id: "event" },
  artifacts: [],
  idempotency: { key: "create", replayed: false },
  observedAt: "2026-10-30T11:35:28.546Z",
  outcome: "applied",
  commit: {
    kind: "provider_accepted",
    id: "provider-event",
    committedAt: "2026-10-30T11:35:28.546Z",
  },
};

it.each([
  ["a read", read, "I couldn't finish that, and nothing was changed."],
  [
    "a committed write",
    write,
    "I couldn't finish that, and part of it may already be done.",
  ],
] as const)(
  "says plainly what happened when scope repair stops after %s",
  async (_kind, receipt, copy) => {
    // tj-97b3ddd147b529: after a calendar read, two CALENDAR_FEED batches
    // left out eliza_turn_scope while work was pending, no failure summary
    // was usable, and the owner got "The planner stopped after repeated
    // invalid scope declarations. ..."
    let requests = 0;
    const execute = vi.fn(async () => ({
      success: true,
      text: "Calendar result",
      effectReceipts: [receipt],
    }));
    const result = await runPlannerLoop({
      context: { id: "scope-failure-copy", events: [] },
      tools: [
        {
          name: "CALENDAR_FEED",
          parameters: {
            type: "object",
            properties: { details: { type: "object" } },
          },
        },
      ],
      runtime: {
        useModel: async (_type, params) => {
          requests++;
          if (!params.tools) return JSON.stringify({ messageToUser: "" });
          return {
            text: "",
            toolCalls: [
              {
                id: `feed-${requests}`,
                name: "CALENDAR_FEED",
                arguments: {
                  details: { date: `2026-10-3${requests}` },
                  ...(requests === 1
                    ? { eliza_turn_scope: "more_work_pending" }
                    : {}),
                },
              },
            ],
          };
        },
      },
      executeToolCall: execute,
      evaluate: async () => ({ success: false, decision: "CONTINUE" as const }),
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.finalMessage).toBeUndefined();
    expect(result.terminalFailure).toMatchObject({
      code: "PLANNER_SCOPE_DECLARATION_REQUIRED",
      message: copy,
    });
    expect(result.terminalFailure?.message).not.toMatch(
      /planner|scope|intent|tool|receipt|—/i,
    );
  },
);

it.each(["steps", "archivedSteps"] as const)(
  "does not claim nothing changed for a resumed nonterminal without a result in %s",
  async (location) => {
    const unresolved = {
      iteration: 0,
      toolCall: { id: "unsettled", name: "WRITE", params: { target: "owned" } },
    };
    const seed: PlannerTrajectory = {
      context: { id: "resume-unknown" },
      steps: location === "steps" ? [unresolved] : [],
      archivedSteps: location === "archivedSteps" ? [unresolved] : [],
      plannedQueue: [],
      evaluatorOutputs: [],
    };
    let requests = 0;
    const execute = vi.fn(async (_call: { name: string }) => ({
      success: true,
      effectReceipts: [read],
    }));
    const result = await runPlannerLoop({
      context: { id: "fresh-authorized-context", events: [] },
      resumeState: {
        trajectory: seed,
        modelUsage: { promptTokens: 0, completionTokens: 0, modelCalls: 0 },
      },
      tools: [
        {
          name: "CALENDAR_FEED",
          parameters: {
            type: "object",
            properties: { details: { type: "object" } },
          },
        },
      ],
      runtime: {
        useModel: async (_type, params) => {
          if (!params.tools) return JSON.stringify({ messageToUser: "" });
          requests++;
          return {
            text: "",
            toolCalls: [
              {
                id: `read-${requests}`,
                name: "CALENDAR_FEED",
                arguments: {
                  details: { date: `day-${requests}` },
                  ...(requests === 1
                    ? { eliza_turn_scope: "more_work_pending" }
                    : {}),
                },
              },
            ],
          };
        },
      },
      executeToolCall: execute,
      evaluate: async () => ({ success: false, decision: "CONTINUE" as const }),
    });
    expect(result.terminalFailure).toMatchObject({
      code: "PLANNER_SCOPE_DECLARATION_REQUIRED",
      message: "I couldn't finish that, and part of it may already be done.",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.every(([call]) => call.name !== "WRITE")).toBe(
      true,
    );
  },
);
