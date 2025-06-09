// Main migrator class
export { PluginMigrator } from './migrator.js';

// Structured migration components
export { StructuredMigrator } from './structured-migrator.js';
export { MigrationStepExecutor } from './migration-step-executor.js';

// Error handling
export { MigrationErrorHandler } from './error-handler.js';

// Types
export type {
  MigrationResult,
  MigrationMetrics,
  MigratorOptions,
  MigrationPhase,
  MigrationStep,
  StepResult,
  MigrationContext,
  MigrationError,
  PackageJsonV2,
  ArchitectureIssue,
  FilePattern,
  FileOperation,
  ImportMapping,
  ModelTypeMapping,
  TestingPattern,
  SuccessMetrics,
  PromptChunk,
  CommandResult,
  EnvironmentValidation,
  PluginStructureValidation,
  ValidationResult,
  ProgressTracker
} from './types.js';

// Mega prompt parser
export {
  IMPORT_MAPPINGS,
  MODEL_TYPE_MAPPINGS,
  ARCHITECTURE_ISSUES,
  parseIntoChunks,
  getCriticalPatternsToAvoid,
  getCodeQualityStandards,
  getSuccessMetrics
} from './mega-prompt-parser.js';

// Test templates
export {
  UTILS_TS_EXACT_CONTENT,
  TEST_TS_TEMPLATE,
  getTestTemplateVariables,
  generateTestContent
} from './test-templates.js';

// Utilities
export { analyzeRepository } from './repository-analyzer.js';
export {
  ensureDependenciesInstalled,
  getAvailableDiskSpace,
  isCommandAvailable,
  safeFileOperation,
  executeWithTimeout,
  createFileWithContent,
  deleteFileOrDirectory,
  createProgressTracker,
  validateEnvironmentFile,
  parseErrorOutput
} from './utils.js';

// Configuration
export {
  MAX_TOKENS,
  BRANCH_NAME,
  CODEX_TIMEOUT,
  MIN_DISK_SPACE_GB,
  LOCK_FILE_NAME,
  DEFAULT_OPENAI_API_KEY,
  MIGRATION_CONFIG,
  FILE_PATTERNS,
  ERROR_PATTERNS,
  V2_DEPENDENCIES,
  V2_DEV_DEPENDENCIES,
  V2_SCRIPTS,
  ENV_VAR_PATTERNS,
  validateMigrationConfig,
  getTimeoutForOperation
} from './config.js';
