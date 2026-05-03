export {
  calculateDiff,
  hasDiffChanges,
  type SchemaDiff,
} from "./drizzle-adapters/diff-calculator";
// Drizzle adapter exports (if needed for extensions)
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
// Storage exports (if needed for advanced usage)
export { MigrationTracker } from "./storage/migration-tracker";
export { SnapshotStorage } from "./storage/snapshot-storage";
export * from "./types";
