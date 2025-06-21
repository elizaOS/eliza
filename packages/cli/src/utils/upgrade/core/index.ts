// Core module exports for structured migration
export { StructuredMigrator } from './structured-migrator.js';
export { MigrationOrchestrator } from './migration-orchestrator.js';
export { ValidationEngine } from './validation-engine.js';
export { ErrorAnalyzer } from './error-analyzer.js';
export { ClaudeIntegration } from './claude-integration.js';
export { RepositoryManager } from './repository-manager.js';
export { EnvironmentManager } from './environment-manager.js';
export { FileOperations } from './file-operations.js';
export { TestManager } from './test-manager.js';

// Export utility functions individually (no class to export)
export * from './migration-utilities.js';

// Re-export types that might be needed by external modules
export type {
  MigrationResult,
  MigratorOptions,
  MigrationContext,
  MigrationStep,
  StepResult,
  FileAnalysis,
  VerificationResult,
  SDKMigrationOptions,
} from '../types.js'; 