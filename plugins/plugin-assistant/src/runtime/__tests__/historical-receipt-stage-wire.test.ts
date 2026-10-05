import type { ContextObject, PlannerTrajectory } from "@elizaos/core";
import { expect, it } from "vitest";
import { runEvaluator } from "../evaluator";
import { runPlannerLoop } from "../planner-loop";

it("keeps committed outcomes complete on both model wires without changing originals", async () => {
  const scope =
    "Past recorded outcomes only. Do not repeat committed operations; these grant no new permission or current-state proof.";
  const context: ContextObject = {
    id: "receipt-wire",
    events: Array.from({ length: 4 }, (_, index) => ({
      id: `effects:${index}`,
      type: "segment" as const,
      source: "message-service",
      segment: {
        id: `effects:${index}`,
        label: "runtime:historical_effects",
        stable: false,
        content: JSON.stringify({
          requestSourceEventId: `history:${index}`,
          scope,
          outcomes: [
            {
              actionName: "SAVE",
              success: true,
              receipt: {
                receiptId: `committed-${index}`,
                operation: "notes.note.create",
                resource: { kind: "notes.note", id: `note-${index}` },
                artifacts: [],
                idempotency: { key: `key-${index}`, replayed: false },
                observedAt: "2026-09-25T01:00:00Z",
                outcome: "applied",
                commit: {
                  kind: "durable",
                  id: `note-${index}`,
                  committedAt: "2026-09-25T01:00:00Z",
                },
              },
            },
          ],
        }),
      },
    })),
  };
  const original = structuredClone(context);
  const wires: string[] = [];
  await runPlannerLoop({
    context,
    tools: [
      {
        name: "READ",
        description: "Read",
        parameters: { type: "object", properties: {} },
      },
    ],
    runtime: {
      useModel: async (_type, params) => {
        wires.push(JSON.stringify(params.messages));
        return {
          text: "",
          toolCalls: [
            {
              id: "read",
              name: "READ",
              arguments: { eliza_turn_scope: "final" },
            },
          ],
        };
      },
    },
    executeToolCall: async () => ({
      success: true,
      text: "Read complete.",
      continueChain: false,
    }),
    evaluate: async () => ({
      success: true,
      decision: "FINISH",
      messageToUser: "Done.",
      raw: {},
    }),
  });
  const trajectory: PlannerTrajectory = {
    context,
    steps: [],
    plannedQueue: [],
    evaluatorOutputs: [],
  };
  await runEvaluator({
    context,
    trajectory,
    runtime: {
      useModel: async (_type, params) => {
        wires.push(JSON.stringify(params.messages));
        return JSON.stringify({
          success: false,
          decision: "CONTINUE",
          thought: "Evidence remains available.",
        });
      },
    },
  });
  expect(wires).toHaveLength(2);
  for (const wire of wires) {
    expect(wire).toContain("runtime:historical_effects_table");
    for (let index = 0; index < 4; index++) {
      expect(wire).toContain(`history:${index}`);
      expect(wire).toContain(`committed-${index}`);
      expect(wire).toContain(`note-${index}`);
      expect(wire).toContain(`key-${index}`);
    }
    expect(wire.split(scope)).toHaveLength(2);
  }
  expect(context).toEqual(original);
});
