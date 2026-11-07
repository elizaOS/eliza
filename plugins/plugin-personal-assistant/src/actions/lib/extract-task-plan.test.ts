import { describe, expect, it } from "vitest";
import { buildCadenceFromLlmParams } from "../life.js";
import { buildTaskCreatePlan } from "./extract-task-plan.js";

describe("buildTaskCreatePlan field normalization", () => {
  it("normalizes cadence casing and window whitespace like the update path", () => {
    const plan = buildTaskCreatePlan({
      mode: "create",
      requestKind: "reminder",
      title: "Stretch",
      cadenceKind: "Weekly",
      windows: [" morning "],
      weekdays: [1, 3],
    });

    expect(plan?.cadenceKind).toBe("weekly");
    expect(plan?.windows).toEqual(["morning"]);
    if (!plan) throw new Error("expected a create plan");
    expect(buildCadenceFromLlmParams(plan)?.cadence).toEqual({
      kind: "weekly",
      weekdays: [1, 3],
      windows: ["morning"],
    });
  });

  it("keeps a padded window on create instead of falling back to morning", () => {
    const plan = buildTaskCreatePlan({
      mode: "create",
      requestKind: "reminder",
      title: "Journal",
      cadenceKind: "daily",
      windows: [" evening "],
    });

    if (!plan) throw new Error("expected a create plan");
    expect(buildCadenceFromLlmParams(plan)?.cadence).toEqual({
      kind: "daily",
      windows: ["evening"],
    });
  });
});
