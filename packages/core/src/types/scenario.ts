import type { UUID } from './primitives';

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