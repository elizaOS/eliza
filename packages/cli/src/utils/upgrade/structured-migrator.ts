// Re-export the refactored StructuredMigrator from the core module
export { StructuredMigrator } from './core/structured-migrator.js';

// Re-export types for backward compatibility
export type {
  MigrationResult,
  MigratorOptions,
  MigrationContext,
  MigrationStep,
  StepResult,
  FileAnalysis,
  VerificationResult,
  SDKMigrationOptions,
} from './types.js';