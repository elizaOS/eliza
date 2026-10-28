import {
  actionToJsonSchema,
  promoteSubactionsToActions,
  validateSchema,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { ownerRemindersAction } from "../owner-surfaces.js";
import {
  parseNativeTaskCreatePlan,
  TASK_CREATE_PLAN_PARAMETER,
} from "./task-create-plan-parameter.js";

const plan = {
  mode: "create",
  requestKind: "reminder",
  nativeProjection: "in_app_only",
  title: "Check packing list",
  description: null,
  cadenceKind: "once",
  windows: [],
  weekdays: [],
  timeOfDay: "12:00",
  timeZone: "America/Los_Angeles",
  dueDate: "2026-10-27",
  dueInDays: null,
  dueWeekday: null,
  dueInMinutes: null,
  multiStep: false,
};
for (const response of [undefined, "", null]) {
  it(`accepts create response placeholder ${String(response)} without altering timing`, () => {
    const input = { ...plan, ...(response === undefined ? {} : { response }) };
    const errors: string[] = [];
    validateSchema(
      TASK_CREATE_PLAN_PARAMETER.schema,
      input,
      "createPlan",
      errors,
    );
    expect(errors).toEqual([]);
    expect(parseNativeTaskCreatePlan(input)).toMatchObject({
      mode: "create",
      response: null,
      timeOfDay: "12:00",
      timeZone: "America/Los_Angeles",
      dueDate: "2026-10-27",
    });
    const child = promoteSubactionsToActions(ownerRemindersAction).find(
      (action) => action.name === "OWNER_REMINDERS_CREATE",
    );
    if (!child) throw new Error("Missing reminder create child");
    const childErrors: string[] = [];
    validateSchema(
      actionToJsonSchema(child),
      { createPlan: input, details: { noAlert: true } },
      "",
      childErrors,
    );
    expect(childErrors).toEqual([]);
  });
}
for (const response of [undefined, "", null]) {
  it(`keeps respond clarification required for ${String(response)}`, () => {
    const errors: string[] = [];
    validateSchema(
      TASK_CREATE_PLAN_PARAMETER.schema,
      {
        mode: "respond",
        multiStep: false,
        requestKind: "reminder",
        ...(response === undefined ? {} : { response }),
      },
      "createPlan",
      errors,
    );
    expect(errors.length).toBeGreaterThan(0);
  });
}
it("retains explicit clarification and unresolved native destination behavior", () => {
  expect(
    parseNativeTaskCreatePlan({
      mode: "respond",
      multiStep: false,
      requestKind: "reminder",
      response: "When should this be due?",
    }),
  ).toMatchObject({ mode: "respond", response: "When should this be due?" });
  expect(
    parseNativeTaskCreatePlan({
      ...plan,
      nativeProjection: null,
      response: "",
    }),
  ).toBeNull();
});

it("rejects non-string, non-null create responses", () => {
  const errors: string[] = [];
  validateSchema(
    TASK_CREATE_PLAN_PARAMETER.schema,
    { ...plan, response: 42 },
    "createPlan",
    errors,
  );
  expect(errors.length).toBeGreaterThan(0);
});
