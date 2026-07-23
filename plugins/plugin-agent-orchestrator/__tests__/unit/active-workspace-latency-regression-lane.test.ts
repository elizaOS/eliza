/**
 * Runs active-workspace provider behavior in an isolated module-mock scope for
 * timeout-removal changes.
 */
import { expect, it } from "vitest";
import "./active-workspace-context.test";
import { activeWorkspaceContextProvider } from "../../src/providers/active-workspace-context";

it("loads the active-workspace latency regression matrix", () => {
  expect(activeWorkspaceContextProvider).toMatchObject({
    name: "ACTIVE_WORKSPACE_CONTEXT",
    cacheStable: false,
    cacheScope: "turn",
  });
});
