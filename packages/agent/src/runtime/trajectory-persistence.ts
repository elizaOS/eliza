/**
 * Trajectory persistence — main entry point.
 *
 * Re-exports the full public API from the decomposed sub-modules:
 *   - trajectory-internals.ts       — shared internal helpers, types, utilities
 *   - trajectory-storage.ts        — trajectory write operations
 *   - trajectory-query.ts          — trajectory read operations
 *   - trajectory-export.ts         — export and archive operations
 *   - trajectory-steps-reader.ts   — CQRS reader for the dedicated steps table
 *   - trajectory-steps-writer.ts   — CQRS writer for the dedicated steps table
 *
 * Types are defined in ../types/trajectory.ts.
 *
 * Step storage:
 *   - Canonical store: `trajectory_steps` table (one row per step).
 *   - Legacy fallback: `trajectories.steps_json` JSONB blob.
 *   - Migration direction: forward only. On first boot after this change,
 *     `ensureTrajectoriesTable` migrates rows from JSONB into the new table.
 *     Writes go to both stores; reads prefer the new table and fall back
 *     to JSONB.
 *   - Scripts: no character cap on the dedicated `script` TEXT column.
 *     The legacy `TRAJECTORY_STEP_SCRIPT_MAX_CHARS=4096` cap remains
 *     applied to the JSONB fallback.
 */

// ---------------------------------------------------------------------------
// Internal helpers (exported for testing / advanced consumers)
// ---------------------------------------------------------------------------
export {
  computeBySource,
  extractInsightsFromResponse,
  extractRows,
  flushObservationBuffer,
  pushChatExchange,
  readOrchestratorTrajectoryContext,
  shouldEnableTrajectoryLoggingByDefault,
  // Testing helpers
  shouldRunObservationExtraction,
  truncateField,
  truncateRecord,
} from "./trajectory-internals.ts";
// ---------------------------------------------------------------------------
// Query — read operations
// ---------------------------------------------------------------------------
export { loadPersistedTrajectoryRows } from "./trajectory-query.ts";
// ---------------------------------------------------------------------------
// Steps — CQRS reader/writer for the dedicated trajectory_steps table
// ---------------------------------------------------------------------------
export {
  DEFAULT_GET_STEPS_LIMIT,
  getSteps,
  loadAllStepsForTrajectory,
  MAX_GET_STEPS_LIMIT,
  type TrajectoryStepsPage,
} from "./trajectory-steps-reader.ts";
export {
  clearAllSteps,
  deleteStepsForTrajectories,
  replaceStepsForTrajectory,
  upsertStep,
} from "./trajectory-steps-writer.ts";
// ---------------------------------------------------------------------------
// Storage — write operations
// ---------------------------------------------------------------------------
export {
  annotateTrajectoryStep,
  clearPersistedTrajectoryRows,
  completeTrajectoryStepInDatabase,
  createDatabaseTrajectoryLogger,
  DatabaseTrajectoryLogger,
  deletePersistedTrajectoryRows,
  flushTrajectoryWrites,
  installDatabaseTrajectoryLogger,
  pruneOldTrajectories,
  startTrajectoryStepInDatabase,
} from "./trajectory-storage.ts";

// ---------------------------------------------------------------------------
// Export — archive operations (available via "./trajectory-export" for
// advanced consumers; not re-exported here to preserve the original API surface)
// ---------------------------------------------------------------------------
