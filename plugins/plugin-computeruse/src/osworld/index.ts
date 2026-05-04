/**
 * OSWorld benchmark integration.
 *
 * Re-exports the adapter, action converter, and types needed
 * to run OSWorld (xlang-ai/OSWorld) benchmarks against this plugin.
 *
 * Usage:
 *   import { OSWorldAdapter, fromOSWorldAction, fromPyAutoGUI } from "@elizaos/plugin-computeruse/osworld";
 */

export {
  fromOSWorldAction,
  fromPyAutoGUI,
  toOSWorldAction,
} from "./action-converter.js";
export { OSWorldAdapter } from "./adapter.js";
export type {
  OSWorldAction,
  OSWorldActionType,
  OSWorldAgentConfig,
  OSWorldObservation,
  OSWorldObservationType,
  OSWorldStepResult,
  OSWorldTaskConfig,
} from "./types.js";
export { DEFAULT_AGENT_CONFIG } from "./types.js";
