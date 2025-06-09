export interface MigrationResult {
  success: boolean;
  branchName: string;
  repoPath: string;
  error?: Error;
  metrics?: MigrationMetrics;
}

export interface MigrationMetrics {
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  duration: number;
  filesChanged: number;
  iterations: number;
  postMigrationIterations: number;
}

export interface MigratorOptions {
  skipTests?: boolean;
  skipValidation?: boolean;
  maxIterations?: number;
  timeout?: number;
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

// Enhanced step interface with better error handling
export interface MigrationStep {
  id: string;
  phase: MigrationPhase;
  name: string;
  description: string;
  required: boolean;
  skipCondition?: (context: MigrationContext) => boolean;
  execute: (context: MigrationContext) => Promise<StepResult>;
  retryCount?: number;
  timeout?: number;
}

export interface StepResult {
  success: boolean;
  message: string;
  error?: Error;
  changes?: string[];
  warnings?: string[];
  duration?: number;
  retryable?: boolean;
}

export interface MigrationContext {
  repoPath: string;
  pluginName: string;
  hasService: boolean;
  hasProviders: boolean;
  hasActions: boolean;
  hasTests: boolean;
  packageJson: PackageJsonV2;
  existingFiles: string[];
  changedFiles: Set<string>;
  codexPrompts: Map<string, string>;
  startTime: number;
  errors: MigrationError[];
}

// Enhanced package.json type for V2 structure
export interface PackageJsonV2 {
  name: string;
  version: string;
  type: 'module';
  main: string;
  module: string;
  types: string;
  exports: {
    './package.json': string;
    '.': {
      import: {
        types: string;
        default: string;
      };
    };
  };
  files: string[];
  repository?: {
    type: string;
    url: string;
  };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  publishConfig?: {
    access: string;
  };
  [key: string]: unknown;
}

// Error tracking
export interface MigrationError {
  type: 'build' | 'test' | 'lint' | 'codex' | 'file-operation' | 'validation';
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  file?: string;
  line?: number;
  phase?: MigrationPhase;
  step?: string;
  timestamp: number;
  fixed?: boolean;
}

// Architecture issue tracking
export interface ArchitectureIssue {
  type:
    | 'missing-service'
    | 'import-incompatibility'
    | 'broken-handler'
    | 'memory-pattern'
    | 'provider-interface'
    | 'config-validation';
  severity: 'critical' | 'high' | 'medium';
  pattern: string;
  solution: string;
  codeExample?: {
    wrong: string;
    correct: string;
  };
}

// File operation types
export interface FilePattern {
  v1Pattern: string;
  v2Pattern: string;
  action: 'delete' | 'move' | 'create' | 'update';
  content?: string;
}

export interface FileOperation {
  type: 'create' | 'update' | 'delete' | 'move';
  source?: string;
  target: string;
  content?: string;
  success?: boolean;
  error?: string;
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

// Enhanced success metrics
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

// Command execution result
export interface CommandResult {
  success: boolean;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  duration: number;
  timedOut?: boolean;
}

// Environment validation
export interface EnvironmentValidation {
  requiredVars: string[];
  missingVars: string[];
  invalidVars: string[];
  recommendations: string[];
}

// V2 Plugin structure validation
export interface PluginStructureValidation {
  hasValidExports: boolean;
  hasService: boolean;
  hasActions: boolean;
  hasProviders: boolean;
  hasTests: boolean;
  hasConfig: boolean;
  issues: string[];
  recommendations: string[];
}

// Remove legacy types and replace with simpler, more focused ones
export interface ValidationResult {
  category: 'build' | 'test' | 'lint' | 'structure';
  success: boolean;
  issues: string[];
  fixes: string[];
}

// Progress tracking
export interface ProgressTracker {
  currentStep: number;
  totalSteps: number;
  currentPhase: MigrationPhase;
  phaseProgress: number;
  overallProgress: number;
  estimatedTimeRemaining?: number;
}
