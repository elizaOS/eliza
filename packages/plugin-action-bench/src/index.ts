import type { Plugin, Action } from "@elizaos/core";
import { typewriterActions } from "./actions/typewriter";
import { multiverseMathActions } from "./actions/multiverseMath";
import { relationalDataActions } from "./actions/relationalData";

// Environment variable configuration
// By default, all are enabled unless explicitly set to "false"
const TYPEWRITER_ENABLED = process.env.TYPEWRITER_ENABLED?.toLowerCase() !== "false";
const MULTIVERSE_MATH_ENABLED = process.env.MULTIVERSE_MATH_ENABLED?.toLowerCase() !== "false";
const RELATIONAL_DATA_ENABLED = process.env.RELATIONAL_DATA_ENABLED?.toLowerCase() !== "false";

// Conditionally build actions array based on environment variables
function buildActions(): Action[] {
  const actions: Action[] = [];
  
  if (TYPEWRITER_ENABLED) {
    console.log("[plugin-action-bench] Typewriter actions enabled");
    actions.push(...typewriterActions);
  } else {
    console.log("[plugin-action-bench] Typewriter actions disabled via TYPEWRITER_ENABLED=false");
  }
  
  if (MULTIVERSE_MATH_ENABLED) {
    console.log("[plugin-action-bench] Multiverse math actions enabled");
    actions.push(...multiverseMathActions);
  } else {
    console.log("[plugin-action-bench] Multiverse math actions disabled via MULTIVERSE_MATH_ENABLED=false");
  }
  
  if (RELATIONAL_DATA_ENABLED) {
    console.log("[plugin-action-bench] Relational data actions enabled");
    actions.push(...relationalDataActions);
  } else {
    console.log("[plugin-action-bench] Relational data actions disabled via RELATIONAL_DATA_ENABLED=false");
  }
  
  // Warn if no actions are enabled
  if (actions.length === 0) {
    console.warn("[plugin-action-bench] WARNING: No benchmark actions are enabled. Set TYPEWRITER_ENABLED=true, MULTIVERSE_MATH_ENABLED=true, or RELATIONAL_DATA_ENABLED=true to enable benchmarks.");
  }
  
  console.log(`[plugin-action-bench] Total actions loaded: ${actions.length}`);
  return actions;
}

// Export with the expected naming convention
export const actionBenchPlugin: Plugin = {
  name: "plugin-action-bench",
  description:
    "Action benchmark plugin providing typewriter (A–Z), multiverse math operations with dimensional constants, and relational data management, testing AI agents' ability to handle action chaining, context-dependent operations, and complex data relationships.",
  actions: buildActions(),
};

// Export configuration for debugging/visibility
export const benchmarkConfig = {
  typewriterEnabled: TYPEWRITER_ENABLED,
  multiverseMathEnabled: MULTIVERSE_MATH_ENABLED,
  relationalDataEnabled: RELATIONAL_DATA_ENABLED,
  totalActionsLoaded: actionBenchPlugin.actions?.length ?? 0,
};

// Default export
export default actionBenchPlugin;
