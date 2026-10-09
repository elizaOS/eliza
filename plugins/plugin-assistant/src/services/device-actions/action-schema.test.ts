import {
  actionToTool,
  buildPlannerToolsFromActions,
  validateToolArgs,
} from "@elizaos/core";
import { expect, test } from "vitest";
import { createAssistantBehavior } from "../../features/basic-capabilities/index.ts";
import { deviceActionForCapabilities, proposeDeviceAction } from "./action.ts";

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
  const ownedAction = deviceActionForCapabilities(proposeDeviceAction, [
    "clock.alarms.v1",
    "clock.handoff.v2",
  ]);
  expect(
    JSON.stringify(deviceActionForCapabilities(proposeDeviceAction).parameters),
  ).not.toContain('"clock_alarm"');
  const alarmId = "12345678-1234-1234-1234-123456789abc";
  const alarmFields = {
    hour: 9,
    minute: 0,
    label: "Morning",
    timeZone: "UTC",
    days: [2, 3, 4, 5, 6],
  };
  for (const operation of [
    { type: "clock_alarm", action: "set", ...alarmFields },
    { type: "clock_alarm", action: "update", alarmId, ...alarmFields },
    { type: "clock_alarm", action: "delete", alarmId },
    { type: "clock_alarm", action: "enable", alarmId, enabled: false },
    { type: "clock_alarm", action: "dismiss", alarmId },
    { type: "clock_alarm", action: "snooze", alarmId, minutes: 10 },
    { type: "clock_alarm", action: "show" },
  ]) {
    const input = {
      operationKey: "synthetic-alarm-op",
      reason: "Owner requested alarm",
      operation,
    };
    const admitted = validateToolArgs(ownedAction, input);
    expect(admitted.valid).toBe(true);
    expect(admitted.args).toEqual(input);
  }
  for (const operation of [
    { type: "clock_handoff", action: "show" },
    { type: "clock_alarm", action: "set", ...alarmFields, days: undefined },
    { type: "clock_alarm", action: "snooze", alarmId, minutes: 61 },
    { type: "clock_alarm", action: "enable", alarmId, enabled: "false" },
    { type: "clock_alarm", action: "dismiss" },
    { type: "create_note", title: "No broadened capability", body: "" },
  ])
    expect(
      validateToolArgs(ownedAction, {
        operationKey: "synthetic-alarm-op",
        reason: "Owner requested alarm",
        operation,
      }).valid,
    ).toBe(false);
});

test("operationKey inference schema mirrors the existing strict identifier contract", () => {
  const tool = actionToTool(proposeDeviceAction).function;
  expect(tool.parameters?.properties?.operationKey).toMatchObject({
    type: "string",
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$",
  });
  for (const operationKey of ["a", "A_0-x", "closed-op-123", "a".repeat(128)])
    expect(
      validateToolArgs(proposeDeviceAction, { ...args(null), operationKey })
        .valid,
    ).toBe(true);
  for (const operationKey of ["", ":urn", "a:b", "a.b", "a b", "a".repeat(129)])
    expect(
      validateToolArgs(proposeDeviceAction, { ...args(null), operationKey })
        .valid,
    ).toBe(false);
});
