/**
 * Runs available-agent failure behavior in its own module-mock scope so
 * degraded state cannot leak into the healthy inventory matrix.
 */
import { expect, it } from "vitest";
import "./available-agents-framework-error.test";
import { availableAgentsProvider } from "../../src/providers/available-agents";

it("loads the available-agent failure regression matrix", () => {
  expect(availableAgentsProvider).toMatchObject({
    name: "AVAILABLE_AGENTS",
    dynamic: true,
  });
});
