/**
 * `@elizaos/plugin-trajectory-logger` package barrel.
 *
 * The Plugin object (runtime contract — view declarations) lives in `./plugin`,
 * free of UI imports, so the agent can register the plugin's views without
 * pulling the React trajectory surface into the Node process. The UI surface (`./register` + `./ui`)
 * is intentionally NOT re-exported here — that pulls React into the agent
 * bundle and fails plugin load. The app loads the UI via the browser entry
 * (`src/ui.ts`) and the Vite view bundle.
 */

export type {
  TrajectoryDetail,
  TrajectoryListItem,
} from "./api-client";
export type { PhaseName, PhaseStatus, PhaseSummary } from "./phases";
export { PHASES, summarizePhases } from "./phases";
export { default, trajectoryLoggerPlugin } from "./plugin.js";
