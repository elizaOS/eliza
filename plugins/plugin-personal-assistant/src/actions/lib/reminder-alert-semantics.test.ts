import { expect, it } from "vitest";
import {
  buildTaskCreatePlan,
  taskCreatePlanGuidance,
} from "./extract-task-plan.js";
import {
  parseNativeTaskCreatePlan,
  TASK_CREATE_PLAN_PARAMETER,
} from "./task-create-plan-parameter.js";

const plan = {
  mode: "create",
  requestKind: "reminder",
  nativeProjection: "in_app_only",
  title: "Packing",
  description: null,
  cadenceKind: "once",
  timeOfDay: "12:00",
  timeZone: "America/Los_Angeles",
  dueDate: "2026-10-27",
  dueInDays: null,
  dueWeekday: null,
  dueInMinutes: null,
  multiStep: false,
};
it.each(["default", "none"] as const)(
  "preserves typed %s alert preference in native and fallback plans",
  (notificationMode) => {
    expect(
      parseNativeTaskCreatePlan({ ...plan, notificationMode })
        ?.notificationMode,
    ).toBe(notificationMode);
    expect(
      buildTaskCreatePlan({ ...plan, notificationMode })?.notificationMode,
    ).toBe(notificationMode);
  },
);
it("does not accept missing notification choice as a complete native reminder", () => {
  expect(parseNativeTaskCreatePlan(plan)).toBeNull();
  expect(buildTaskCreatePlan(plan)?.notificationMode).toBeNull();
});
it("teaches both native and fallback schemas the independent preference", () => {
  expect(JSON.stringify(TASK_CREATE_PLAN_PARAMETER.schema)).toContain(
    "notificationMode",
  );
  expect(taskCreatePlanGuidance(true)).toContain("notificationMode");
});

it("rejects explicit invalid notification values instead of guessing", () => {
  expect(
    buildTaskCreatePlan({ ...plan, notificationMode: "silent-ish" }),
  ).toBeNull();
});
