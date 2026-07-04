/** Public entry point for the diff-based schema runtime migrator: re-exports the diff/snapshot/SQL-generation adapters, the migrator itself, its storage layers, and its types. */
export {
  calculateDiff,
  hasDiffChanges,
  type SchemaDiff,
} from "./drizzle-adapters/diff-calculator";
export {
  createEmptySnapshot,
  generateSnapshot,
  hasChanges,
  hashSnapshot,
} from "./drizzle-adapters/snapshot-generator";
export {
  generateMigrationSQL,
  generateRenameColumnSQL,
  generateRenameTableSQL,
} from "./drizzle-adapters/sql-generator";
export { RuntimeMigrator } from "./runtime-migrator";
export { JournalStorage } from "./storage/journal-storage";
export { MigrationTracker } from "./storage/migration-tracker";
export { SnapshotStorage } from "./storage/snapshot-storage";
export * from "./types";
