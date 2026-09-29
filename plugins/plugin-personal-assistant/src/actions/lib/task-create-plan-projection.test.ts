import { expect, it } from "vitest";
import { buildTaskCreatePlan } from "./extract-task-plan";
import { parseNativeTaskCreatePlan } from "./task-create-plan-parameter";

const plan = {
  mode: "create",
  requestKind: "reminder",
  title: "QA",
  cadenceKind: "once",
  dueInMinutes: 2,
  multiStep: false,
};
it.each(["in_app_only", "apple_reminders"])(
  "preserves projection %s in both semantic paths",
  (nativeProjection) => {
    expect(
      buildTaskCreatePlan({ ...plan, nativeProjection })?.nativeProjection,
    ).toBe(nativeProjection);
    expect(
      parseNativeTaskCreatePlan({ ...plan, nativeProjection })
        ?.nativeProjection,
    ).toBe(nativeProjection);
  },
);
it("preserves omitted legacy behavior and rejects invalid projection", () => {
  expect(parseNativeTaskCreatePlan(plan)?.nativeProjection).toBeNull();
  expect(
    parseNativeTaskCreatePlan({ ...plan, nativeProjection: "invalid" }),
  ).toBeNull();
  expect(
    buildTaskCreatePlan({ ...plan, nativeProjection: "invalid" }),
  ).toBeNull();
});

it.each([{ value: ["in_app_only"] }, { value: {} }, { value: 1 }])(
  "rejects non-string projection %j",
  ({ value: nativeProjection }) => {
    expect(buildTaskCreatePlan({ ...plan, nativeProjection })).toBeNull();
    expect(parseNativeTaskCreatePlan({ ...plan, nativeProjection })).toBeNull();
  },
);
