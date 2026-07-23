/**
 * Runs available-agent inventory behavior in an isolated module-mock scope for
 * timeout-removal changes.
 */
import { expect, it } from "vitest";
import "./available-agents.test";
import {
  acpAvailableAgentsProvider,
  availableAgentsProvider,
} from "../../src/providers/available-agents";

it("loads the available-agent inventory regression matrix", () => {
  expect(acpAvailableAgentsProvider).toBe(availableAgentsProvider);
});
