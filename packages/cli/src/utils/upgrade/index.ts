// Main migrator class
export { PluginMigrator } from './migrator.js';

// Structured migration components
export { StructuredMigrator } from './structured-migrator.js';
export { MigrationStepExecutor } from './migration-step-executor.js';

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
  PromptChunk
} from './types.js';

// Mega prompt parser
export {
  IMPORT_MAPPINGS,
  MODEL_TYPE_MAPPINGS,
  ARCHITECTURE_ISSUES,
  parseIntoChunks
} from './mega-prompt-parser.js';

// Test templates
export {
  UTILS_TS_EXACT_CONTENT,
  TEST_TS_TEMPLATE
} from './test-templates.js';

// Context-aware test generation
export { ContextAwareTestGenerator } from './context-aware-test-generator.js';

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
