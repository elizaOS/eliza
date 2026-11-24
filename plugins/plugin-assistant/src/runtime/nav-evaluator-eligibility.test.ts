import { readFileSync } from "node:fs";
import type { ContextObject, PlannerTrajectory } from "@elizaos/core";
import { expect, test } from "vitest";
import { runEvaluator } from "./evaluator.ts";
import { isDeliveredNavigationOnlyTurn } from "./nav-evaluator-eligibility";
import fixture from "./navigation-replay.fixture.json";

const replay = () => structuredClone(fixture.trajectory);
type Replay = ReturnType<typeof replay>;
// Negative replay cases intentionally exercise the real function at its JS boundary.
const eligible = (trajectory: unknown) =>
  Reflect.apply(isDeliveredNavigationOnlyTurn, undefined, [trajectory]);
test("exact fresh OG delivered-navigation trajectory is eligible without inventing a mutation receipt", () => {
  const t = replay();
  expect(eligible(t)).toBe(true);
  expect(t.steps[0].result).not.toHaveProperty("effectReceipts");
  expect(fixture.rawEvaluator.replyEffectStatus).toBe("applied");
});
test("failed, prepared, fake, mismatched and wrong-step deliveries do not qualify", () => {
  for (const change of [
    (t: Replay) => (t.steps[0].result.success = false),
    (t: Replay) => (t.steps[0].result.data.navigation.status = "prepared"),
    (t: Replay) =>
      (t.steps[0].result.data.values.completedActionDelivered = false),
    (t: Replay) =>
      (t.steps[0].result.data.values.completedActionHandoffId = "other"),
    (t: Replay) => (t.steps[0].result.data.view.id = "other"),
    (t: Replay) => {
      Object.assign(t.steps[0].toolCall.params, {
        navigationStepId: "this-step",
      });
      Object.assign(t.steps[0].result.data.navigation, {
        stepId: "another-step",
      });
    },
    (t: Replay) => (t.steps[0].toolCall.params.view = "calendar"),
  ]) {
    const t = replay();
    change(t);
    expect(eligible(t)).toBe(false);
  }
});
test("historical same-view delivery, mixed work and pending effects preserve unrestricted classification plus existing guard", () => {
  for (const change of [
    (t: Replay) => {
      Object.assign(t, { archivedSteps: t.steps, steps: [] });
    },
    (t: Replay) => t.outcomeIntents.push("Create a note"),
    (t: Replay) =>
      Object.assign(t, { plannedQueue: [{ name: "NOTES_CREATE" }] }),
    (t: Replay) =>
      Object.assign(t, {
        steps: [
          ...t.steps,
          { toolCall: { name: "NOTES_CREATE" }, result: { success: true } },
        ],
      }),
    (t: Replay) =>
      Object.assign(t.steps[0].result, {
        effectReceipts: [{ outcome: "applied" }],
      }),
  ]) {
    const t = replay();
    change(t);
    expect(eligible(t)).toBe(false);
  }
});
/** The decision state the real evaluator sends the model for this turn. */
async function decisionState(
  trajectory: Replay,
  hasUnresolvedToolFailure = false,
): Promise<string> {
  const context: ContextObject = {
    id: "turn",
    events: [
      {
        id: "current",
        type: "message",
        message: {
          id: "current",
          role: "user",
          content: "Open the Notes view",
        },
      },
    ],
  };
  let sent = "";
  await runEvaluator({
    context,
    trajectory: {
      ...trajectory,
      context,
      modelBaseContext: context,
    } as unknown as PlannerTrajectory,
    ...(hasUnresolvedToolFailure ? { hasUnresolvedToolFailure } : {}),
    runtime: {
      useModel: async (
        _type: unknown,
        request: { messages: { content: unknown }[] },
      ) => {
        sent = String(request.messages.at(-1)?.content);
        return JSON.stringify({
          thought: "The view opened.",
          success: true,
          decision: "FINISH",
          replyEffectStatus: "none",
          messageToUser: "Notes is open.",
        });
      },
    },
  } as never);
  return sent;
}
test("actual evaluator leaves the cloned status enum complete and tells only an eligible turn that applied has no proof; raw applied verdict is never silently repaired", async () => {
  const source = readFileSync(
    new URL("./evaluator.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    "  const responseSchema = structuredClone(evaluatorSchema);",
  );
  const end = source.indexOf("  const initialBudgetOptions", start);
  const apply = new Function(
    "evaluatorSchema",
    "params",
    "decisionState = { intents: [] }",
    `${source.slice(start, end)}return responseSchema;`,
  );
  const original = {
    properties: {
      replyEffectStatus: { enum: ["none", "applied", "non_applied"] },
      effectReceiptIds: { type: "array", items: { type: "string" } },
    },
  };
  const before = JSON.stringify(original);
  const schema = apply(original, {
    context: { metadata: {} },
    trajectory: replay(),
  });
  // The schema is the same on every turn: the decision state tells an eligible
  // turn that applied has no proof, and the receipt guard enforces it.
  expect(schema.properties.replyEffectStatus.enum).toEqual([
    "none",
    "applied",
    "non_applied",
  ]);
  expect(JSON.stringify(original)).toBe(before);
  expect(schema.properties.effectReceiptIds).toEqual(
    original.properties.effectReceiptIds,
  );
  const noProofLine =
    "replyEffectStatus: none or non_applied. This turn delivered view navigation only and committed no effect receipt, so applied has no proof.";
  expect(await decisionState(replay())).toContain(noProofLine);
  // A commit recorded beside the navigation: the navigation is still the only
  // executed step, and the turn has proof an applied reply can select.
  const committedAt = "2026-11-20T21:25:00.000Z";
  const withCommit = replay();
  Object.assign(withCommit, {
    steps: [
      ...withCommit.steps,
      {
        terminalOnly: true,
        result: {
          success: true,
          effectReceipts: [
            {
              receiptId: "real-mutation-receipt",
              operation: "notes.note.create",
              resource: { kind: "notes.note", id: "note-1" },
              artifacts: [],
              idempotency: { key: "create-key", replayed: false },
              observedAt: committedAt,
              outcome: "applied",
              commit: { kind: "durable", id: "note-1", committedAt },
            },
          ],
        },
      },
    ],
  });
  expect(eligible(withCommit)).toBe(true);
  const withCommitState = await decisionState(withCommit);
  expect(withCommitState).toContain(
    'Committed effect receipt IDs: ["real-mutation-receipt"]',
  );
  expect(withCommitState).not.toContain("replyEffectStatus:");
  expect(await decisionState(replay(), true)).not.toContain(
    "replyEffectStatus:",
  );
  expect(source).toContain(
    '"The reply claims a completed change without committed receipt evidence.',
  );
});
