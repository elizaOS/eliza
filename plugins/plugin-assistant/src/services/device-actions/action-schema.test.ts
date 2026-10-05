import {
  actionToTool,
  buildPlannerToolsFromActions,
  validateToolArgs,
} from "@elizaos/core";
import { expect, test } from "vitest";
import { createAssistantBehavior } from "../../features/basic-capabilities/index.ts";
import { proposeDeviceAction } from "./action.ts";

const target = {
  sourceId: "selected",
  sourceRevision: "v1",
  reminderId: "reminder",
  occurrenceId: "occurrence",
  revision: "v1",
};
const args = (recurrence: unknown) => ({
  operationKey: "synthetic-op",
  reason: "Owner requested review",
  operation: {
    type: "reminder_update",
    target,
    fields: {
      title: "Synthetic reminder",
      body: "Reviewed text",
      schedule: { at: 1790900000000, recurrence },
    },
  },
});
test("actual reminder action reaches inference schema and preserves explicit no-repeat after tool admission", () => {
  const actions = createAssistantBehavior().actions ?? [];
  expect(actions).toContain(proposeDeviceAction);
  const tools = buildPlannerToolsFromActions(actions);
  expect(tools).toHaveLength(actions.length);
  const tool = tools.find(
    (candidate) => candidate.name === "PROPOSE_DEVICE_ACTION",
  );
  expect(tool?.name).toBe("PROPOSE_DEVICE_ACTION");
  expect(JSON.stringify(tool?.parameters)).toContain('"type":"null"');
  expect(actionToTool(proposeDeviceAction).function.parameters).toEqual(
    tool?.parameters,
  );
  const input = args(null);
  const result = validateToolArgs(proposeDeviceAction, input);
  expect(result.errors).toEqual([]);
  expect(result.valid).toBe(true);
  expect(result.args).toEqual(input);
  const recurring = args({
    rule: "daily",
    zone: "America/New_York",
    date: "2026-10-02",
    time: "09:00",
    leadMinutes: 0,
  });
  expect(validateToolArgs(proposeDeviceAction, recurring).args).toEqual(
    recurring,
  );
  for (const value of [false, "none", 0, [], { rule: "invalid" }])
    expect(validateToolArgs(proposeDeviceAction, args(value)).valid).toBe(
      false,
    );
  const missing = args(null);
  delete (missing.operation.fields.schedule as { recurrence?: unknown })
    .recurrence;
  expect(validateToolArgs(proposeDeviceAction, missing).valid).toBe(false);
  for (const operation of [
    { type: "create_note", title: "Synthetic note", body: "Exact content" },
    {
      type: "notes_update",
      target: {
        sourceId: "s",
        sourceRevision: "1",
        noteId: "n",
        revision: "1",
      },
      fields: { title: "T", body: "B" },
    },
    {
      type: "calendar_read_selected",
      target: {
        sourceId: "s",
        sourceRevision: "1",
        eventId: "e",
        revision: "1",
      },
    },
  ]) {
    const prior = {
      operationKey: "synthetic-op",
      reason: "Owner requested review",
      operation,
    };
    const admitted = validateToolArgs(proposeDeviceAction, prior);
    expect(admitted.valid).toBe(true);
    expect(admitted.args).toEqual(prior);
  }
  const nonNullable = args(null);
  (nonNullable.operation.fields as { title: unknown }).title = null;
  expect(validateToolArgs(proposeDeviceAction, nonNullable).valid).toBe(false);
});
