import type { UUID } from './uuid';

/**
 * Environment validation result for plugin scenarios
 */
export interface PluginEnvironmentValidation {
  isValid: boolean;
  missingVars: string[];
  warnings: string[];
  pluginName: string;
}

/**
 * Agent configuration parameter from package.json
 */
export interface AgentConfigParameter {
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  sensitive?: boolean;
  default?: any;
}

/**
 * Character definition for scenario testing
 */
export interface ScenarioCharacter {
  id: UUID;
  name: string;
  role: 'subject' | 'observer' | 'assistant' | 'adversary';
  bio?: string;
  system?: string;
  plugins: string[]; // Plugin names that this character requires
  settings?: Record<string, any>;
  messageExamples?: Array<Array<{ user: string; content: { text: string; actions?: string[] } }>>;
}

/**
 * Script step for scenario execution
 */
export interface ScenarioStep {
  id?: string;
  type: 'message' | 'wait' | 'action' | 'assert' | 'condition';
  from?: string; // Character ID who performs this step
  content?: string; // Message content
  duration?: number; // For wait steps
  actionName?: string; // For action steps
  actionParams?: Record<string, any>; // Action parameters
  expected_actions?: string[]; // Expected actions to be triggered
  assertion?: {
    type: 'contains' | 'regex' | 'count' | 'custom';
    value: any;
    description: string;
  };
  condition?: string; // For condition steps
  description?: string;
  timeout?: number;
  critical?: boolean; // Fail scenario if this step fails
}

/**
 * Scenario script defining the interaction flow
 */
export interface ScenarioScript {
  steps: ScenarioStep[];
  goals?: string[]; // High-level objectives
  triggers?: Array<{
    on: 'message_received' | 'keyword' | 'timer' | 'custom';
    condition: string;
    response: ScenarioStep[];
  }>;
}

/**
 * Verification rule for scenario outcome validation
 */
export interface ScenarioVerificationRule {
  id: string;
  type: 'llm'; // All verification is LLM-based
  description: string;
  config: {
    successCriteria: string;
    priority?: 'high' | 'medium' | 'low';
    category?: 'functionality' | 'performance' | 'integration' | 'collaboration';
    context?: Record<string, any>;
    weight?: number; // Impact on overall score (default: 1.0)
  };
}

/**
 * Verification configuration for scenarios
 */
export interface ScenarioVerification {
  rules: ScenarioVerificationRule[];
  expectedOutcomes?: Array<{
    actorId: string;
    outcome: string;
  }>;
  groundTruth?: {
    correctAnswer?: any;
    expectedBehavior?: string;
    successCriteria?: string[];
  };
}

/**
 * Scenario setup configuration
 */
export interface ScenarioSetup {
  timeout?: number; // Max execution time in milliseconds
  maxSteps?: number; // Max number of steps to execute
  environment?: Record<string, any>; // Additional environment setup
  roomType?: 'group' | 'dm' | 'public';
  roomName?: string;
  context?: string; // Additional context for the scenario
}

/**
 * Plugin-embedded scenario definition
 */
export interface PluginScenario {
  id: UUID;
  name: string;
  description: string;
  category?: 'functionality' | 'integration' | 'performance' | 'stress';
  tags?: string[];

  // Character definitions for this scenario
  characters: ScenarioCharacter[];

  // Execution script
  script: ScenarioScript;

  // Verification rules
  verification: ScenarioVerification;

  // Optional setup configuration
  setup?: ScenarioSetup;

  // Computed environment requirements (populated during validation)
  requiredEnvVars?: string[];
}

/**
 * Scenario execution result
 */
export interface ScenarioExecutionResult {
  scenarioId: UUID;
  name: string;
  passed: boolean;
  skipped?: boolean;
  skipReason?: string;
  duration: number;
  score: number; // 0-1 based on verification rules
  startTime: number;
  endTime: number;

  // Execution metrics
  metrics: {
    stepCount: number;
    messageCount: number;
    actionCount: number;
    tokenUsage: {
      input: number;
      output: number;
      total: number;
    };
    responseLatency: {
      min: number;
      max: number;
      average: number;
      p95: number;
    };
    memoryUsage: {
      peak: number;
      average: number;
      operations: number;
    };
  };

  // Verification results
  verificationResults: Array<{
    ruleId: string;
    passed: boolean;
    score: number;
    reason?: string;
    details?: any;
  }>;

  // Execution transcript
  transcript: Array<{
    timestamp: number;
    step: ScenarioStep;
    result?: any;
    error?: string;
  }>;

  // Any errors that occurred
  errors: string[];
}

/**
 * Combined test results for plugin testing
 */
export interface PluginTestResults {
  pluginName: string;
  testSuites: Array<{
    name: string;
    passed: boolean;
    duration: number;
    tests: Array<{
      name: string;
      passed: boolean;
      error?: string;
    }>;
  }>;
  scenarios: ScenarioExecutionResult[];
  environmentValidation: PluginEnvironmentValidation[];
  summary: {
    totalTests: number;
    passedTests: number;
    totalScenarios: number;
    passedScenarios: number;
    skippedScenarios: number;
    overallSuccess: boolean;
  };
}

/**
 * Extended scenario types for testing file system, Git, and API operations
 * Required for comprehensive bulk plugin update testing
 */

// Base interface for extended scenario steps
export interface ExtendedScenarioStepBase {
  id?: string;
  description?: string;
  timeout?: number;
  critical?: boolean; // Fail scenario if this step fails
}

// File system operation testing
export interface FileSystemStep extends ExtendedScenarioStepBase {
  type: 'file_operation';
  operation: 'read' | 'write' | 'create' | 'delete' | 'copy' | 'move' | 'exists' | 'mkdir';
  path: string;
  content?: string;
  expectedContent?: string;
  permissions?: string;
  backup?: boolean;
  validateJson?: boolean;
  encoding?: 'utf8' | 'binary';
}

// Git operation testing
export interface GitStep extends ExtendedScenarioStepBase {
  type: 'git_operation';
  operation: 'clone' | 'checkout' | 'branch' | 'commit' | 'push' | 'pull' | 'status' | 'diff';
  repository?: string;
  branch?: string;
  commitMessage?: string;
  remote?: string;
  workingDirectory: string;
  expectedFiles?: string[];
  expectedBranches?: string[];
  expectedCommits?: number;
}

// API call testing
export interface ApiStep extends ExtendedScenarioStepBase {
  type: 'api_call';
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  body?: any;
  expectedStatus: number;
  expectedResponse?: any;
  timeout?: number;
  retries?: number;
  mock?: {
    enabled: boolean;
    response: any;
    delay?: number;
  };
}

// External command execution testing
export interface CommandStep extends ExtendedScenarioStepBase {
  type: 'command';
  command: string;
  args: string[];
  expectedExitCode: number;
  expectedOutput?: string | RegExp;
  expectedError?: string | RegExp;
  workingDirectory?: string;
  timeout?: number;
  environment?: Record<string, string>;
}

// Bulk operation testing
export interface BulkOperationStep extends ExtendedScenarioStepBase {
  type: 'bulk_operation';
  operation: string;
  targets: string[];
  parallelism?: number;
  failureStrategy: 'stop_on_first' | 'continue_all' | 'stop_on_threshold';
  failureThreshold?: number;
  progressTracking?: boolean;
  batchSize?: number;
  timeout?: number;
}

// Validation step for complex checks
export interface ValidationStep extends ExtendedScenarioStepBase {
  type: 'validation';
  checks: ValidationCheck[];
  failOnAny?: boolean;
}

export interface ValidationCheck {
  name: string;
  type: 'file_exists' | 'file_content' | 'git_status' | 'package_json' | 'custom';
  target?: string;
  expected?: any;
  validator?: (actual: any) => boolean | Promise<boolean>;
}

// Extended scenario configuration
export interface ExtendedScenarioSetup {
  sandbox?: {
    enabled: boolean;
    tempDirectory?: string;
    cleanupStrategy: 'always' | 'on_success' | 'never';
    allowedOperations: string[];
    gitConfig?: {
      name: string;
      email: string;
    };
  };
  github?: {
    token?: string;
    organization?: string;
    mockApi?: boolean;
  };
  filesystem?: {
    allowedPaths: string[];
    restrictToTemp?: boolean;
  };
}

// Union type for all extended steps
export type ExtendedScenarioStep =
  | FileSystemStep
  | GitStep
  | ApiStep
  | CommandStep
  | BulkOperationStep
  | ValidationStep;

// Extended scenario with new capabilities
export interface ExtendedScenario {
  id: string;
  name: string;
  description: string;
  category: 'bulk_operations' | 'file_system' | 'git' | 'api' | 'integration';
  tags: string[];
  setup: ExtendedScenarioSetup;
  steps: ExtendedScenarioStep[];
  cleanup?: ExtendedScenarioStep[];
  verification: {
    rules: ValidationCheck[];
  };
  metadata?: {
    timeout?: number;
    retries?: number;
    parallel?: boolean;
  };
}
