export { RuntimeMigrator } from './runtime-migrator';
export * from './types';

// Storage exports (if needed for advanced usage)
export { MigrationTracker } from './storage/migration-tracker';
export { JournalStorage } from './storage/journal-storage';
export { SnapshotStorage } from './storage/snapshot-storage';

// Drizzle adapter exports (if needed for extensions)
export {
  generateSnapshot,
  hashSnapshot,
  createEmptySnapshot,
  hasChanges,
} from './drizzle-adapters/snapshot-generator';

export { calculateDiff, hasDiffChanges, type SchemaDiff } from './drizzle-adapters/diff-calculator';

export {
  generateMigrationSQL,
  generateRenameTableSQL,
  generateRenameColumnSQL,
} from './drizzle-adapters/sql-generator';
