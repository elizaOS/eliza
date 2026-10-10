/** Retrieval never serves a search entry its action has since changed. */
import type { Action } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { retrieveContextualPlannerActions } from "./action-surface";

function action(name: string, description: string): Action {
  return {
    name,
    description,
    contexts: ["general"],
    similes: [],
    examples: [],
    validate: async () => true,
    handler: async () => ({ success: true }),
  };
}

describe("planner search catalog freshness", () => {
  it("reindexes an action whose description was reassigned", () => {
    const relay = action("RELAY", "Send a message through a connector.");
    const actions = [relay, action("EVENT_CREATE", "Create a calendar event.")];
    const names = () =>
      retrieveContextualPlannerActions({
        actions,
        query: "zorblax",
      }).actions.map((entry) => entry.name);
    expect(names()).not.toContain("RELAY");
    relay.description = "Send a message. connectors[1]: zorblax";
    expect(names()).toContain("RELAY");
  });
});
