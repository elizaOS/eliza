/** Preserves assistant export imports while core owns canonical trajectory serialization. */
export {
  buildElizaNativeTrajectoryRows,
  iterateTrajectoryLlmCalls,
  resolveJsonShape,
  resolveTrajectoryStatus,
  serializeTrajectoryExport,
  summarizeTrajectoryCache,
  summarizeTrajectoryUsage,
} from "@elizaos/core";
export {
  type TrajectoryPlaintextOptions,
  trajectoryToPlaintext,
} from "@elizaos/shared/activity-plaintext";
