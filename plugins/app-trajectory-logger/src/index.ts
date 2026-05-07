/**
 * Public entry for @elizaos/app-trajectory-logger.
 *
 * The app is a UI-only overlay — it does not register a runtime plugin or
 * any new HTTP routes. It consumes the existing `/api/trajectories` and
 * `/api/trajectories/:id` endpoints provided by `@elizaos/app-training`.
 */

export type {
  TrajectoryDetail,
  TrajectoryListItem,
  TrajectoryListResult,
  UIEvaluationEvent,
  UILlmCall,
  UIProviderAccess,
  UIToolCallStatus,
  UIToolEvent,
} from "./api-client";
export {
  fetchTrajectoryDetail,
  fetchTrajectoryList,
} from "./api-client";
export type {
  PhaseName,
  PhaseStatus,
  PhaseSummary,
} from "./phases";
export {
  extractShouldRespondDecision,
  PHASES,
  summarizePhases,
} from "./phases";
export {
  registerTrajectoryLoggerApp,
  TRAJECTORY_LOGGER_APP_NAME,
  TrajectoryLoggerView,
  trajectoryLoggerApp,
} from "./ui";
export { usePollingTrajectories } from "./usePollingTrajectories";
