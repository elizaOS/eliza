import { expect, it } from "vitest";
import { promoteSubactionsToActions } from "../../core/src/actions/promote-subactions.ts";
import {
  actionToTool,
  buildPlannerToolsFromActions,
} from "../../core/src/actions/to-tool.ts";
import { triggerAction } from "../src/actions/trigger.ts";

function promoted(name: string) {
  const virtual = promoteSubactionsToActions(triggerAction).find(
    (action) => action.name === name,
  );
  if (!virtual) throw new Error(`${name} was not promoted`);
  return virtual;
}

function requiredFor(name: string): readonly string[] {
  return actionToTool(promoted(name)).function.parameters.required ?? [];
}

/** The description the planner reads for one exposed TRIGGER operation. */
function plannerDescription(name: string): string {
  return buildPlannerToolsFromActions([promoted(name)])[0]?.description ?? "";
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

// Live tj-d221dfaa4d6a2e: the first TRIGGER_CREATE for "set a reminder for 20
// minutes from now to stretch" carried no schedule and failed
// MISSING_SCHEDULE. No one field is required, so the tool names every field
// that satisfies the handler.
it("TRIGGER_CREATE names each schedule field a create needs one of", () => {
  const description = plannerDescription("TRIGGER_CREATE");
  for (const field of [
    "delayMinutes",
    "delaySeconds",
    "scheduledAtIso",
    "cronExpression",
    "intervalMs",
  ])
    expect(description).toContain(field);
});

// Live tj-d24d0ef3e2f2ed: with only TRIGGER_DELETE exposed, "actually make it
// 30 minutes" deleted the reminder and never set it again.
it("TRIGGER_DELETE routes a change to an existing reminder to update", () => {
  expect(plannerDescription("TRIGGER_DELETE")).toContain(
    "Use update to change an existing reminder's time",
  );
});

// Live tj-b020ae0157c06c: with OWNER_REMINDERS exposed beside TRIGGER,
// "actually make that 30 minutes" after an OWNER_REMINDERS create went to
// TRIGGER_UPDATE with the owner reminder's id and failed TRIGGER_NOT_FOUND.
it("TRIGGER sends a reminder OWNER_REMINDERS saved back to OWNER_REMINDERS", () => {
  expect(plannerDescription("TRIGGER_UPDATE")).toContain(
    "a reminder saved through OWNER_REMINDERS is changed with OWNER_REMINDERS",
  );
  const taskId = actionToTool(promoted("TRIGGER_UPDATE")).function.parameters
    .properties?.taskId;
  expect(taskId?.description).toContain(
    "An OWNER_REMINDERS reminder id is not a taskId",
  );
  expect(triggerAction.routingHint).toContain(
    "is updated, toggled or deleted through OWNER_REMINDERS, not TRIGGER",
  );
  // Without LifeOps, TRIGGER stays the reminder surface.
  expect(triggerAction.routingHint).toContain(
    "core fallback when OWNER_REMINDERS is unavailable",
  );
});
