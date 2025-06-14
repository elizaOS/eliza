export interface MigrationResult {
  success: boolean;
  branchName: string;
  repoPath: string;
  error?: Error;
}

export interface MigratorOptions {
  skipTests?: boolean;
  skipValidation?: boolean;
}

// Migration phases from the mega prompt
export type MigrationPhase =
  | 'pre-migration-analysis'
  | 'file-structure-migration'
  | 'core-structure-migration'
  | 'configuration-migration'
  | 'actions-migration'
  | 'provider-migration'
  | 'testing-infrastructure'
  | 'documentation-assets'
  | 'build-quality-validation'
  | 'final-integration-validation';

// Detailed step interface
export interface MigrationStep {
  id: string;
  phase: MigrationPhase;
  name: string;
  description: string;
  required: boolean;
  skipCondition?: (context: MigrationContext) => boolean;
  execute: (context: MigrationContext) => Promise<StepResult>;
}

export interface StepResult {
  success: boolean;
  message: string;
  error?: Error;
  changes?: string[];
  warnings?: string[];
}

export interface MigrationContext {
  repoPath: string;
  pluginName: string;
  hasService: boolean;
  hasProviders: boolean;
  hasActions: boolean;
  hasTests: boolean;
  packageJson: {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    [key: string]: unknown;
  };
  existingFiles: string[];
  changedFiles: Set<string>;
  claudePrompts: Map<string, string>;
  collectedEnvVars?: Record<string, string>;
}

// Critical architecture issues from mega prompt
export interface ArchitectureIssue {
  type:
    | 'missing-service'
    | 'import-incompatibility'
    | 'broken-handler'
    | 'memory-pattern'
    | 'provider-interface'
    | 'config-validation'
    | 'test-import-issue'
    | 'test-runtime-mock'
    | 'test-state-object'
    | 'service-registration'
    | 'test-command-issue'
    | 'test-export-name'
    | 'action-example-role'
    | 'config-field-visibility'
    | 'handler-options-type'
    | 'handler-promise-boolean'
    | 'handler-optional-params'
    | 'handler-default-options'
    | 'handler-arrow-function'
    | 'memory-upsert-pattern'
    | 'memory-search-pattern'
    | 'memory-content-fields'
    | 'database-adapter-memory';
  severity: 'critical' | 'high' | 'medium';
  pattern: string;
  solution: string;
  codeExample?: {
    wrong: string;
    correct: string;
  };
}

// File structure patterns
export interface FilePattern {
  v1Pattern: string;
  v2Pattern: string;
  action: 'delete' | 'move' | 'create' | 'update';
  content?: string;
}

// Import mapping
export interface ImportMapping {
  oldImport: string | RegExp;
  newImport: string;
  description: string;
}

// Model type mapping
export interface ModelTypeMapping {
  v1: string;
  v2: string;
  description: string;
}

// Testing pattern
export interface TestingPattern {
  name: string;
  template: string;
  requiredImports: string[];
}

// Success metrics from mega prompt
export interface SuccessMetrics {
  technicalValidation: {
    cleanBuild: boolean;
    properTypes: boolean;
    serviceIntegration: boolean;
    actionFunctionality: boolean;
    testCoverage: boolean;
  };
  architectureCompliance: {
    servicePattern: boolean;
    memoryPattern: boolean;
    configurationPattern: boolean;
    errorPattern: boolean;
    fileStructure: boolean;
  };
  codeQuality: {
    noCustomPatterns: boolean;
    properCleanup: boolean;
    eventIntegration: boolean;
    security: boolean;
    documentation: boolean;
  };
}

// Prompt chunks from mega prompt
export interface PromptChunk {
  id: string;
  title: string;
  content: string;
  phase: MigrationPhase;
  criticalPoints: string[];
  codeExamples?: Array<{
    title: string;
    wrong: string;
    correct: string;
  }>;
}

// Legacy types for backward compatibility
export interface AnalyzedError {
  category: 'syntax' | 'import' | 'type' | 'runtime' | 'test' | 'build' | 'linting';
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  file?: string;
  line?: number;
  column?: number;
  autoFixable: boolean;
  blocking: boolean;
  elizaosSpecific: boolean;
  priority: number;
}

export interface PrioritizedIssue extends AnalyzedError {
  priorityScore: number;
  context: string;
  suggestedFix?: string;
}

export interface IterationRecord {
  iteration: number;
  timestamp: Date;
  duration: number;
  issuesAddressed: number;
  successfulFixes: number;
  codebaseHealth: number;
  consecutiveSuccesses: number;
  errors: AnalyzedError[];
  fixes: FixAttempt[];
}

export interface FixAttempt {
  issue: PrioritizedIssue;
  prompt: string;
  success: boolean;
  newErrors?: AnalyzedError[];
  duration: number;
}

export interface SuccessPattern {
  signature: string;
  approach: string;
  count: number;
  successRate: number;
  lastUsed: Date;
  context: string;
}

export interface ErrorPattern {
  pattern: RegExp;
  category: AnalyzedError['category'];
  severity: AnalyzedError['severity'];
  autoFixable: boolean;
  elizaosSpecific: boolean;
  promptTemplate: string;
  priority: number;
}

// NEW: File analysis interface for migration assessment
export interface FileAnalysis {
  hasV1Imports: boolean;
  hasV1ServicePattern: boolean;
  hasV1ActionPattern: boolean;
  hasV1MemoryPattern: boolean;
  hasV1ConfigPattern: boolean;
  hasV1ModelAPI: boolean;
  hasV1TestPattern: boolean;
  complexityScore: number;
  v1PatternCount: number;
}

// NEW: Migration verification result interface
export interface VerificationResult {
  success: boolean;
  issues: string[];
}
