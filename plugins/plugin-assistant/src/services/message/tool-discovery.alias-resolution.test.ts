/** Exercises real registry resolution between planner discovery and cloud MCP aliases. */
import { describe, expect, it } from "vitest";
import { mcpAction } from "../../../../../packages/cloud/shared/src/lib/eliza/plugin-mcp/actions/mcp";
import {
  buildRuntimeActionLookup,
  resolveRuntimeAction,
} from "./action-identifiers";
import { createPlannerToolDiscoveryAction } from "./tool-discovery";

describe("planner discovery and MCP name ownership", () => {
  it("resolves canonical and legacy discovery to one action while preserving MCP search", () => {
    const discovery = createPlannerToolDiscoveryAction([], () => undefined);
    for (const actions of [
      [mcpAction, discovery],
      [discovery, mcpAction],
    ]) {
      const lookup = buildRuntimeActionLookup({ actions });
      expect(resolveRuntimeAction(lookup, "DISCOVER_ACTIONS")).toBe(discovery);
      expect(resolveRuntimeAction(lookup, "DISCOVER_TOOLS")).toBe(discovery);
      expect(resolveRuntimeAction(lookup, "SEARCH_ACTIONS")).toBe(mcpAction);
      expect(resolveRuntimeAction(lookup, "FIND_ACTIONS")).toBe(mcpAction);
    }
    const withoutPlanner = buildRuntimeActionLookup({ actions: [mcpAction] });
    expect(
      resolveRuntimeAction(withoutPlanner, "DISCOVER_ACTIONS"),
    ).toBeUndefined();
    expect(
      resolveRuntimeAction(withoutPlanner, "DISCOVER_TOOLS"),
    ).toBeUndefined();
  });
});
