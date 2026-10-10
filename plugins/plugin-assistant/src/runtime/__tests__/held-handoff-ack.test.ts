/**
 * Replies of a turn whose only work is handing a task to a background agent.
 * Once the handoff is accepted, the planner loop delivers the acknowledgement
 * Stage 1 drafted and the handoff action held, instead of a forced synthesis,
 * a rescue and the host's reply recovery.
 */
import type { PlannerToolResult } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { runPlannerLoop } from "../planner-loop";
import { runSubPlanner } from "../sub-planner";
import { stageOneEvent } from "./planner-fixtures";
import { ACCEPTED_SPAWN_RECEIPT } from "./receipts";

const DRAFT = "Starting the build now; the link follows when it is ready.";
const SYNTHESIZED = "The build is running in the background.";

const spawnResult = {
  success: true,
  asyncHandoff: true,
  text: 'Spawned coding sub-agent "demo page" (claude). It is working asynchronously — its result is not available yet and will arrive as a follow-up message.',
  effectReceipts: [ACCEPTED_SPAWN_RECEIPT],
  data: { actionName: "TASKS_SPAWN_AGENT" },
  continueChain: false,
} satisfies PlannerToolResult;

async function runSpawnTurn(options: {
  replyEffectStatus?: string;
  result?: PlannerToolResult;
  nested?: true;
}) {
  const calls: string[] = [];
  const loop = {
    runtime: {
      useModel: async (modelType: unknown) => {
        calls.push(String(modelType));
        if (calls.length === 1)
          return {
            text: "",
            toolCalls: [
              {
                id: "spawn",
                name: "TASKS_SPAWN_AGENT",
                arguments: {
                  task: "Build a small demo page.",
                  eliza_turn_scope: "final",
                },
              },
            ],
          };
        if (calls.length === 2)
          // The forced no-tools synthesis pass.
          return JSON.stringify({
            toolCalls: [],
            messageToUser: SYNTHESIZED,
            completed: true,
          });
        // Last-resort rescue: nothing usable comes back.
        return "";
      },
    } as never,
    context: {
      id: "handoff-turn",
      // No tool event: a tool that discovery loads mid-turn never gets one.
      events: [
        stageOneEvent({
          undeliveredDraft: {
            replyText: DRAFT,
            instruction: "This Stage-1 draft was not delivered.",
          },
          plan: {
            contexts: ["general"],
            replyEffectStatus: options.replyEffectStatus ?? "pending",
            intents: ["build the demo page"],
            candidateActions: ["TASKS"],
            reply: "",
          },
        }),
      ],
    },
  };
  const result = options.nested
    ? await runSubPlanner({
        ...loop,
        action: {
          name: "TASKS",
          subActions: [{ name: "TASKS_SPAWN_AGENT", asyncHandoff: true }],
        } as never,
        ctx: { message: {}, userRoles: ["OWNER"] } as never,
        // The child's own result is unmarked: the sub-planner knows the action.
        execute: async () => ({ ...spawnResult, asyncHandoff: undefined }),
      })
    : await runPlannerLoop({
        deferInternalReplyRecoveryToCaller: true,
        ...loop,
        tools: [
          {
            name: "TASKS_SPAWN_AGENT",
            description: "Spawn a coding sub-agent.",
            parameters: { type: "object", properties: {} },
          },
        ],
        executeToolCall: async () => options.result ?? spawnResult,
      });
  return { result, calls };
}

describe("held async handoff acknowledgement", () => {
  it("delivers Stage 1's held ack once the handoff is accepted", async () => {
    const { result, calls } = await runSpawnTurn({});
    expect(result.finalMessage).toBe(DRAFT);
    // The planner call only: no forced synthesis and no rescue.
    expect(calls).toHaveLength(1);
    expect(result.replyRecoveryRequired).toBeUndefined();
  });

  it.each([
    [
      "the tool is not an async handoff",
      { result: { ...spawnResult, asyncHandoff: undefined } },
    ],
    ["the draft was for applied work", { replyEffectStatus: "applied" }],
    [
      "the handoff has no applied receipt",
      { result: { ...spawnResult, effectReceipts: [] } },
    ],
  ])("keeps the synthesis path when %s", async (_label, options) => {
    const { result, calls } = await runSpawnTurn(options);
    expect(calls.length).toBeGreaterThan(1);
    expect(result.finalMessage).toBe(SYNTHESIZED);
  });

  it("delivers the held ack for a handoff a nested sub-planner ran", async () => {
    const { result, calls } = await runSpawnTurn({ nested: true });
    expect(result.finalMessage).toBe(DRAFT);
    expect(calls).toHaveLength(1);
  });
});
