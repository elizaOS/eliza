import { expect, it } from "vitest";
import { promoteSubactionsToActions } from "../../core/src/actions/promote-subactions.ts";
import { actionToTool } from "../../core/src/actions/to-tool.ts";
import { triggerAction } from "../src/actions/trigger.ts";

function requiredFor(name: string): readonly string[] {
  const virtual = promoteSubactionsToActions(triggerAction).find(
    (action) => action.name === name,
  );
  if (!virtual) throw new Error(`${name} was not promoted`);
  return actionToTool(virtual).function.parameters.required ?? [];
}

// Live 2026-10-30 tj-6e8277ba0331ca: with taskId optional on TRIGGER_UPDATE
// the planner sent the update without it three times (MISSING_TASK_ID each
// time) before a fourth round supplied the id.
it("TRIGGER_UPDATE's tool schema requires the taskId its handler requires", () => {
  expect(requiredFor("TRIGGER_UPDATE")).toContain("taskId");
});

it("taskId stays optional where a displayName fragment resolves the trigger", () => {
  for (const name of ["TRIGGER_DELETE", "TRIGGER_RUN", "TRIGGER_TOGGLE"]) {
    expect(requiredFor(name)).not.toContain("taskId");
  }
  expect(
    triggerAction.parameters?.find((p) => p.name === "taskId")?.required,
  ).toBe(false);
});
