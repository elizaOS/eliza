import type { ActionPlan } from "@elizaos/core";

/**
 * Benchmark Configuration
 */
export interface BenchmarkConfig {
  // Runtime configuration
  realmBenchPath?: string;
  apiBankPath?: string;

  // Benchmark options
  runRealmBench: boolean;
  runApiBank: boolean;
  maxTestsPerCategory?: number;
  timeoutMs?: number;

  // Output configuration
  outputDir: string;
  saveDetailedLogs: boolean;

  // Performance monitoring
  enableMetrics: boolean;
  enableMemoryTracking: boolean;
}

/**
 * REALM-Bench Task Definition
 */
export interface RealmBenchTask {
  id: string;
  name: string;
  description: string;
  goal: string;
  requirements: string[];
  constraints: Record<string, unknown>;
  expectedOutcome: string;
  availableTools: string[];
  timeoutMs?: number;
  maxSteps?: number;
}

/**
 * REALM-Bench Test Case
 */
export interface RealmBenchTestCase {
  task: RealmBenchTask;
  input: {
    message: string;
    context?: Record<string, unknown>;
    attachments?: unknown[];
  };
  expected: {
    actions: string[];
    outcome: string;
    metrics: {
      maxDuration?: number;
      minSteps?: number;
      maxSteps?: number;
      requiredActions?: string[];
    };
  };
}

/**
 * REALM-Bench Execution Result
 */
export interface RealmBenchResult {
  testCaseId: string;
  taskId: string;
  success: boolean;
  duration: number;
  stepsExecuted: number;
  actionsPerformed: string[];
  planGenerated: ActionPlan | null;
  error?: string;
  metrics: {
    planningTime: number;
    executionTime: number;
    planQuality: number;
    goalAchievement: number;
    efficiency: number;
  };
  details: {
    planAdaptations: number;
    errorRecoveries: number;
    resourceUsage: Record<string, unknown>;
  };
}

/**
 * REALM-Bench Report
 */
export interface RealmBenchReport {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  averageDuration: number;
  averageSteps: number;
  averagePlanQuality: number;
  averageGoalAchievement: number;
  averageEfficiency: number;
  results: RealmBenchResult[];
  summary: {
    taskCategories: Record<
      string,
      {
        count: number;
        successRate: number;
        averageScore: number;
      }
    >;
    commonFailures: string[];
    recommendations: string[];
  };
}

/**
 * API-Bank Test Case
 */
export interface ApiBankTestCase {
  id: string;
  level: 1 | 2 | 3;
  description: string;
  query: string;
  availableApis: ApiBankApi[];
  expectedApiCalls: ApiBankApiCall[];
  expectedResponse: string;
}

/**
 * API-Bank API Definition
 */
export interface ApiBankApi {
  name: string;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
  }>;
  returns: string;
}

/**
 * API-Bank API Call
 */
export interface ApiBankApiCall {
  api: string;
  parameters: Record<string, unknown>;
}

/**
 * API-Bank Result
 */
export interface ApiBankResult {
  testCaseId: string;
  level: number;
  success: boolean;
  duration: number;
  apiCallsPlanned: ApiBankApiCall[];
  apiCallsExpected: ApiBankApiCall[];
  responseGenerated: string;
  responseExpected: string;
  metrics: {
    planningTime: number;
    executionTime: number;
    apiCallAccuracy: number;
    parameterAccuracy: number;
    responseQuality: number;
  };
  error?: string;
}

/**
 * API-Bank Report
 */
export interface ApiBankReport {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  results: ApiBankResult[];
  levelBreakdown: Record<
    number,
    {
      total: number;
      passed: number;
      successRate: number;
    }
  >;
  overallMetrics: {
    averageApiCallAccuracy: number;
    averageParameterAccuracy: number;
    averageResponseQuality: number;
  };
}

/**
 * Comprehensive Benchmark Results
 */
export interface BenchmarkResults {
  metadata: {
    timestamp: string;
    duration: number;
    configuration: Partial<BenchmarkConfig>;
  };

  realmBenchResults?: RealmBenchReport;
  apiBankResults?: ApiBankReport;

  overallMetrics: {
    totalTests: number;
    totalPassed: number;
    overallSuccessRate: number;
    averagePlanningTime: number;
    averageExecutionTime: number;
    memoryUsage: {
      peak: number;
      average: number;
    };
  };

  comparison: {
    planningVsBaseline: {
      improvementRate: number;
      categories: string[];
    };
    strengthsAndWeaknesses: {
      strengths: string[];
      weaknesses: string[];
      recommendations: string[];
    };
  };

  summary: {
    status: "success" | "partial" | "failed";
    keyFindings: string[];
    performanceScore: number;
  };
}
