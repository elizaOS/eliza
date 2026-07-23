/**
 * Runs coding-session change grounding in an isolated module-mock scope for
 * timeout-removal changes.
 */
import { expect, it } from "vitest";
import "./coding-session-changes.test";

it("loads the coding-session latency regression matrix", () => {
  expect(true).toBe(true);
});
