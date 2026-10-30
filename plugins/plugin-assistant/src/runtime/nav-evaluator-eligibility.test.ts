import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
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
test("actual evaluator changes only cloned eligibility enum; raw applied verdict is never silently repaired", () => {
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
    "availableReceiptIds",
    "params",
    "isDeliveredNavigationOnlyTurn",
    "decisionState = { intents: [] }",
    source.slice(start, end) + "return responseSchema;",
  );
  const original = {
    properties: {
      replyEffectStatus: { enum: ["none", "applied", "non_applied"] },
      effectReceiptIds: { type: "array", items: { type: "string" } },
    },
  };
  const before = JSON.stringify(original);
  const schema = apply(
    original,
    [],
    { trajectory: replay() },
    isDeliveredNavigationOnlyTurn,
  );
  expect(schema.properties.replyEffectStatus.enum).toEqual([
    "none",
    "non_applied",
  ]);
  expect(schema.properties.replyEffectStatus.enum).not.toContain(
    fixture.rawEvaluator.replyEffectStatus,
  );
  expect(JSON.stringify(original)).toBe(before);
  expect(schema.properties.effectReceiptIds).toEqual(
    original.properties.effectReceiptIds,
  );
  expect(
    apply(
      original,
      ["real-mutation-receipt"],
      { trajectory: replay() },
      isDeliveredNavigationOnlyTurn,
    ).properties.replyEffectStatus.enum,
  ).toContain("applied");
  expect(
    apply(
      original,
      [],
      { trajectory: replay(), hasUnresolvedToolFailure: true },
      isDeliveredNavigationOnlyTurn,
    ).properties.replyEffectStatus.enum,
  ).toContain("applied");
  expect(source).toContain(
    '"The reply claims a completed change without committed receipt evidence.',
  );
});
