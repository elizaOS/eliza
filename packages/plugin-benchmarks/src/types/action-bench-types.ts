export interface ActionEvaluationConfig {
  requiresOrder: boolean;
}

export interface ResponseEvaluationConfig {
  enabled: boolean;
  criteria?: string; // Natural language description of what to evaluate
}

export interface TestStep {
  stepId: number;
  userMessage: string;
  expectedActions: string[];
  expectedPatterns?: string[]; // For retail tests - patterns to check in response
  requireActions?: boolean; // For retail tests - whether actions must be executed
  waitForFinalResponse?: boolean; // For retail tests - wait for final response
  actionEvaluation: ActionEvaluationConfig;
  responseEvaluation: ResponseEvaluationConfig;
}

export interface TestDefinition {
  testId: string;
  name: string;
  category?: string; // Test category (e.g., 'retail', 'typing')
  description?: string; // Detailed description of the test
  steps: TestStep[];
}

export interface TestSuite {
  testSuite: string;
  tests: TestDefinition[];
}

export interface StepResult {
  stepId: number;
  passed: boolean;
  collectedActions: string[];
  agentResponse: string;
  actionEvaluation: {
    passed: boolean;
    details: string;
  };
  responseEvaluation?: {
    passed: boolean;
    score: number;
    reasoning: string;
  };
  patternEvaluation?: {
    passed: boolean;
    details: string;
  };
}

export interface TestResult {
  testId: string;
  testName: string;
  totalSteps: number;
  successfulSteps: number;
  successRate: number;
  stepResults: StepResult[];
  overallPassed: boolean;
}
