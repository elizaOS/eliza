/**
 * Runs coding-session change grounding in an isolated module-mock scope for
 * timeout-removal changes.
 */
import { expect, it } from "vitest";
import "./coding-session-changes.test";
import { codingSessionChangesProvider } from "../../src/providers/coding-session-changes";

it("loads the coding-session latency regression matrix", () => {
  expect(codingSessionChangesProvider).toMatchObject({
    name: "CODING_SESSION_CHANGES",
    cacheStable: false,
    cacheScope: "turn",
  });
});
