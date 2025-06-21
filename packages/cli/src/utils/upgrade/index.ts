// Main migrator class
export { PluginMigrator } from './migrator.js';

// Structured migration components
export { StructuredMigrator } from './structured-migrator.js';

// Core migration components
export * from './core/index.js';

// Migration patterns (replaces mega-prompt-parser)
export * from './migration-patterns/index.js';

// Migration steps components
export * from './migration-steps/index.js';

// File migration components
export * from './file-migration/index.js';

// Test generation components - NEW MODULAR APPROACH
export * from './test-generation/index.js';

// Environment variable prompting
export { EnvPrompter } from './env-prompter.js';
export type { EnvVarPrompt, CollectedEnvVars } from './env-prompter.js';

// Types
export type {
  MigrationResult,
  MigratorOptions,
  MigrationPhase,
  MigrationStep,
  StepResult,
  MigrationContext,
  ArchitectureIssue,
  FilePattern,
  ImportMapping,
  ModelTypeMapping,
  TestingPattern,
  SuccessMetrics,
  PromptChunk,
  // Enhanced SDK types
  SDKPhaseResult,
  SDKMigrationOptions,
  ClaudeSDKAdapter,
  MigrationMetrics,
  PhaseMetrics,
  SessionManager,
  MigrationMetricsCollector
} from './types.js';

// Test templates - NEW CENTRALIZED APPROACH
export {
  buildTestGenerationPrompt,
  generateRobustTemplateVariables,
  getTestTemplateVariables,
  type TestTemplateVariables
} from './test-templates/test-template.js';

// Legacy test templates for backward compatibility
export {
  UTILS_TS_EXACT_CONTENT
} from './test-templates/index.js';

// Claude SDK - Export all SDK functionality
export {
  EnhancedClaudeSDKAdapter,
  createMigrationMetricsCollector,
  createSessionManager,
  importClaudeSDK,
  isClaudeSDKAvailable,
  validateClaudeSDKEnvironment,
  getSDKErrorContext,
  type SDKMessage,
  type ClaudeQueryOptions,
  type ClaudeQueryParams,
  type ClaudeSDKModule
} from './claude-sdk/index.js';

// Context-aware test generation functionality is now handled by modular components:
// - PluginAnalyzer (./test-generation/plugin-analyzer.js)
// - TestValidator (./test-generation/test-validator.js)  
// - buildTestGenerationPrompt (./test-templates/test-template.js)

// Utilities
export { analyzeRepository } from './repository-analyzer.js';
export {
  getAvailableDiskSpace
} from './utils.js';

// Configuration
export {
  MAX_TOKENS,
  BRANCH_NAME,
  CLAUDE_CODE_TIMEOUT,
  MIN_DISK_SPACE_GB,
  LOCK_FILE_NAME
} from './config.js';
