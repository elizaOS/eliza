/**
 * `@elizaos/plugin-trajectory-logger` package barrel.
 *
 * The Plugin object (runtime contract — view declarations) lives in `./plugin`,
 * free of UI imports, so the agent can register the plugin's views without
 * pulling the React trajectory surface into the Node process. This barrel
 * re-exports it alongside the UI and SDK surface for browser/view-bundle and
 * direct consumers.
 */

export type {
  TrajectoryDetail,
  TrajectoryListItem,
} from "./api-client";
export type { PhaseName, PhaseStatus, PhaseSummary } from "./phases";
export { PHASES, summarizePhases } from "./phases";
export { default, trajectoryLoggerPlugin } from "./plugin.js";
export * from "./register";
export {
  registerTrajectoryLoggerApp,
  TRAJECTORY_LOGGER_APP_NAME,
  TrajectoryLoggerView,
  trajectoryLoggerApp,
} from "./ui";
