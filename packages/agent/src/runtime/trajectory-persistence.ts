/**
 * Trajectory persistence — main entry point.
 *
 * Re-exports the full public API from the decomposed sub-modules:
 *   - trajectory-internals.ts — shared internal helpers, types, and utilities
 *   - trajectory-storage.ts  — write operations (save, update, delete, logger)
 *   - trajectory-query.ts    — read operations (list, load)
 *   - trajectory-export.ts   — export and archive operations
 *
 * Types are defined in ../types/trajectory.ts.
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
