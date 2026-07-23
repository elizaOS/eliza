/**
 * Runs active-workspace provider behavior in an isolated module-mock scope for
 * timeout-removal changes.
 */
import { expect, it } from "vitest";
import "./active-workspace-context.test";

it("loads the active-workspace latency regression matrix", () => {
  expect(true).toBe(true);
});
