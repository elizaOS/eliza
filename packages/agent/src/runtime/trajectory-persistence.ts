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
  // Testing helpers
  shouldRunObservationExtraction,
  truncateField,
  truncateRecord,
  extractInsightsFromResponse,
  pushChatExchange,
  flushObservationBuffer,
  extractRows,
  computeBySource,
  readOrchestratorTrajectoryContext,
  shouldEnableTrajectoryLoggingByDefault,
} from "./trajectory-internals.js";

// ---------------------------------------------------------------------------
// Storage — write operations
// ---------------------------------------------------------------------------
export {
  installDatabaseTrajectoryLogger,
  startTrajectoryStepInDatabase,
  completeTrajectoryStepInDatabase,
  deletePersistedTrajectoryRows,
  clearPersistedTrajectoryRows,
  flushTrajectoryWrites,
  pruneOldTrajectories,
  DatabaseTrajectoryLogger,
  createDatabaseTrajectoryLogger,
} from "./trajectory-storage.js";

// ---------------------------------------------------------------------------
// Query — read operations
// ---------------------------------------------------------------------------
export {
  loadPersistedTrajectoryRows,
} from "./trajectory-query.js";

// ---------------------------------------------------------------------------
// Export — archive operations (available via "./trajectory-export" for
// advanced consumers; not re-exported here to preserve the original API surface)
// ---------------------------------------------------------------------------
