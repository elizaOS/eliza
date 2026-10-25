import { expect, it } from "vitest";
import { createScenarioRuntimeLifecycle } from "./runtime-lifecycle.ts";

it("drains startup resources in reverse order, restores environment, and closes once", async () => {
  const original = process.env.ELIZA_SCENARIO_LIFECYCLE_TEST;
  const scope = createScenarioRuntimeLifecycle();
  const calls: string[] = [];
  scope.own("first", () => {
    calls.push("first");
  });
  scope.own("second", async () => {
    calls.push("second");
  });
  process.env.ELIZA_SCENARIO_LIFECYCLE_TEST = "owned";
  expect(() => createScenarioRuntimeLifecycle()).toThrow("already owns");
  await scope.close();
  await scope.close();
  expect(calls).toEqual(["second", "first"]);
  expect(process.env.ELIZA_SCENARIO_LIFECYCLE_TEST).toBe(original);
  const next = createScenarioRuntimeLifecycle();
  await next.close();
});

it("retains each cleanup failure and quarantines the process", async () => {
  const scope = createScenarioRuntimeLifecycle();
  const calls: string[] = [];
  scope.own("first", () => {
    calls.push("first");
    throw new Error("first failure");
  });
  scope.own("second", () => {
    calls.push("second");
    throw new Error("second failure");
  });
  await expect(scope.close()).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ message: "second failure" }),
      expect.objectContaining({ message: "first failure" }),
    ],
  });
  expect(calls).toEqual(["second", "first"]);
  expect(() => createScenarioRuntimeLifecycle()).toThrow("already owns");
});
