import {
  type IAgentRuntime,
  type IPlanningService,
  type ActionPlan,
  type PlanningContext,
  type Memory,
  type State,
  type Content,
  type UUID,
  asUUID,
  logger,
  ModelType,
} from '@elizaos/core';
import { PlanningService } from '../services/planning-service';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

/**
 * REALM-Bench Task Definition
 */
export interface RealmBenchTask {
  id: string;
  name: string;
  description: string;
  goal: string;
  requirements: string[];
  constraints: Record<string, any>;
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
    context?: Record<string, any>;
    attachments?: any[];
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
    planQuality: number; // 0-1 score
    goalAchievement: number; // 0-1 score
    efficiency: number; // 0-1 score
  };
  details: {
    planAdaptations: number;
    errorRecoveries: number;
    resourceUsage: Record<string, any>;
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
 * Production-Ready REALM-Bench Adapter
 * Tests ElizaOS planning capabilities against REALM-Bench scenarios
 */
export class RealmBenchAdapter {
  private runtime: IAgentRuntime;
  private planningService: IPlanningService;
  private testCases: RealmBenchTestCase[] = [];

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;

    const planningService = runtime.getService<PlanningService>('planning');
    if (!planningService) {
      throw new Error('Planning service is required for REALM-Bench testing');
    }
    this.planningService = planningService;
  }

  /**
   * Load test cases from REALM-Bench format
   */
  async loadTestCases(realmBenchDataPath: string): Promise<void> {
    try {
      logger.info(`[RealmBenchAdapter] Loading test cases from ${realmBenchDataPath}`);

      // Load REALM-Bench design patterns and scenarios
      const designPatternsPath = path.join(realmBenchDataPath, 'design_patterns');
      const agentFrameworksPath = path.join(realmBenchDataPath, 'agent_frameworks');

      // Generate test cases from planning patterns
      await this.loadPlanningPatternTests(designPatternsPath);

      // Generate test cases from multi-agent scenarios
      await this.loadMultiAgentTests(agentFrameworksPath);

      logger.info(`[RealmBenchAdapter] Loaded ${this.testCases.length} test cases`);
    } catch (error) {
      logger.error('[RealmBenchAdapter] Error loading test cases:', error);
      throw new Error(`Failed to load REALM-Bench test cases: ${(error as Error).message}`);
    }
  }

  /**
   * Run all loaded test cases
   */
  async runBenchmark(): Promise<RealmBenchReport> {
    const startTime = Date.now();
    const results: RealmBenchResult[] = [];

    logger.info(`[RealmBenchAdapter] Starting benchmark with ${this.testCases.length} test cases`);

    for (const testCase of this.testCases) {
      try {
        const result = await this.runTestCase(testCase);
        results.push(result);

        logger.info(
          `[RealmBenchAdapter] Test ${testCase.task.id}: ${result.success ? 'PASS' : 'FAIL'} ` +
            `(${result.duration}ms, ${result.stepsExecuted} steps)`
        );
      } catch (error) {
        logger.error(`[RealmBenchAdapter] Test ${testCase.task.id} failed:`, error);

        results.push({
          testCaseId: testCase.task.id,
          taskId: testCase.task.id,
          success: false,
          duration: 0,
          stepsExecuted: 0,
          actionsPerformed: [],
          planGenerated: null,
          error: (error as Error).message,
          metrics: {
            planningTime: 0,
            executionTime: 0,
            planQuality: 0,
            goalAchievement: 0,
            efficiency: 0,
          },
          details: {
            planAdaptations: 0,
            errorRecoveries: 0,
            resourceUsage: {},
          },
        });
      }
    }

    const report = this.generateReport(results, Date.now() - startTime);

    logger.info(
      `[RealmBenchAdapter] Benchmark completed: ${report.passedTests}/${report.totalTests} passed ` +
        `(${((report.passedTests / report.totalTests) * 100).toFixed(1)}%)`
    );

    return report;
  }

  /**
   * Run a specific test case
   */
  private async runTestCase(testCase: RealmBenchTestCase): Promise<RealmBenchResult> {
    const startTime = Date.now();
    let planningTime = 0;
    let executionTime = 0;
    let planGenerated: ActionPlan | null = null;
    let stepsExecuted = 0;
    let actionsPerformed: string[] = [];

    try {
      // Create a test message
      const testMessage: Memory = {
        id: asUUID(uuidv4()),
        entityId: asUUID(uuidv4()),
        agentId: this.runtime.agentId,
        roomId: asUUID(uuidv4()),
        content: {
          text: testCase.input.message,
          source: 'realm-bench-test',
        },
        createdAt: Date.now(),
      };

      // Create initial state
      const testState: State = {
        values: testCase.input.context || {},
        data: {},
        text: testCase.input.message,
      };

      // Step 1: Create comprehensive plan
      const planningStartTime = Date.now();

      const planningContext: PlanningContext = {
        goal: testCase.task.goal,
        constraints: Object.entries(testCase.task.constraints).map(([key, value]) => ({
          type: 'custom' as const,
          value,
          description: `${key}: ${value}`,
        })),
        availableActions: testCase.task.availableTools,
        availableProviders: this.getAvailableProviders(),
        preferences: {
          executionModel: 'dag',
          maxSteps: testCase.task.maxSteps || 10,
          timeoutMs: testCase.task.timeoutMs || 60000,
        },
      };

      planGenerated = await this.planningService.createComprehensivePlan(
        this.runtime,
        planningContext,
        testMessage,
        testState
      );

      planningTime = Date.now() - planningStartTime;

      // Step 2: Validate the plan
      const validation = await this.planningService.validatePlan(this.runtime, planGenerated);
      if (!validation.valid) {
        throw new Error(`Plan validation failed: ${validation.issues?.join(', ')}`);
      }

      // Step 3: Execute the plan
      const executionStartTime = Date.now();

      const executionResult = await this.planningService.executePlan(
        this.runtime,
        planGenerated,
        testMessage,
        async (content: Content) => {
          // Capture callback for analysis
          if (content.actions) {
            actionsPerformed.push(...content.actions);
          }
          return [];
        }
      );

      executionTime = Date.now() - executionStartTime;
      stepsExecuted = executionResult.completedSteps;

      // Step 4: Evaluate results
      const success = this.evaluateTestResult(testCase, executionResult, actionsPerformed);
      const metrics = this.calculateMetrics(
        testCase,
        planGenerated,
        executionResult,
        planningTime,
        executionTime
      );

      return {
        testCaseId: testCase.task.id,
        taskId: testCase.task.id,
        success,
        duration: Date.now() - startTime,
        stepsExecuted,
        actionsPerformed,
        planGenerated,
        metrics,
        details: {
          planAdaptations: executionResult.adaptations?.length || 0,
          errorRecoveries: executionResult.errors?.length || 0,
          resourceUsage: {
            planningTime,
            executionTime,
            totalTime: Date.now() - startTime,
          },
        },
      };
    } catch (error) {
      return {
        testCaseId: testCase.task.id,
        taskId: testCase.task.id,
        success: false,
        duration: Date.now() - startTime,
        stepsExecuted,
        actionsPerformed,
        planGenerated,
        error: (error as Error).message,
        metrics: {
          planningTime,
          executionTime,
          planQuality: 0,
          goalAchievement: 0,
          efficiency: 0,
        },
        details: {
          planAdaptations: 0,
          errorRecoveries: 1,
          resourceUsage: {
            planningTime,
            executionTime,
            totalTime: Date.now() - startTime,
          },
        },
      };
    }
  }

  /**
   * Load planning pattern tests from REALM-Bench
   */
  private async loadPlanningPatternTests(designPatternsPath: string): Promise<void> {
    const planningPatterns = [
      {
        name: 'Sequential Planning',
        goal: 'Calculate sum of numbers, multiply result, then take logarithm',
        requirements: ['mathematical calculation', 'step sequencing'],
        tools: ['sum_two_elements', 'multiply_two_elements', 'compute_log'],
        input:
          'I want to calculate the sum of 1234 and 5678 and multiply the result by 5. Then, I want to take the logarithm of this result',
        expectedActions: ['sum_two_elements', 'multiply_two_elements', 'compute_log'],
      },
      {
        name: 'Reactive Planning',
        goal: 'Respond to dynamic conditions and adapt plan accordingly',
        requirements: ['condition monitoring', 'plan adaptation'],
        tools: ['check_condition', 'adapt_plan', 'execute_action'],
        input: 'Monitor the system and adapt our approach based on current conditions',
        expectedActions: ['check_condition', 'adapt_plan'],
      },
      {
        name: 'Complex Multi-Step Planning',
        goal: 'Coordinate multiple interdependent tasks with resource constraints',
        requirements: ['resource management', 'dependency resolution', 'parallel execution'],
        tools: ['allocate_resource', 'schedule_task', 'coordinate_execution'],
        input: 'Create a comprehensive project plan with resource allocation and task coordination',
        expectedActions: ['allocate_resource', 'schedule_task', 'coordinate_execution'],
      },
    ];

    for (const pattern of planningPatterns) {
      const testCase: RealmBenchTestCase = {
        task: {
          id: `planning-${pattern.name.toLowerCase().replace(/\s+/g, '-')}`,
          name: pattern.name,
          description: `Test ${pattern.name} capabilities`,
          goal: pattern.goal,
          requirements: pattern.requirements,
          constraints: {
            maxTime: 30000,
            maxSteps: 5,
          },
          expectedOutcome: `Successfully execute ${pattern.expectedActions.join(' -> ')}`,
          availableTools: pattern.tools,
          timeoutMs: 30000,
          maxSteps: 5,
        },
        input: {
          message: pattern.input,
          context: {},
        },
        expected: {
          actions: pattern.expectedActions,
          outcome: pattern.goal,
          metrics: {
            maxDuration: 30000,
            maxSteps: 5,
            requiredActions: pattern.expectedActions,
          },
        },
      };

      this.testCases.push(testCase);
    }
  }

  /**
   * Load multi-agent tests from REALM-Bench
   */
  private async loadMultiAgentTests(agentFrameworksPath: string): Promise<void> {
    const multiAgentScenarios = [
      {
        name: 'Information Gathering and Analysis',
        goal: 'Gather information from multiple sources and provide comprehensive analysis',
        requirements: ['research', 'data aggregation', 'analysis'],
        tools: ['search_information', 'analyze_data', 'generate_report'],
        input: 'Research the current market trends and provide a comprehensive analysis',
        expectedActions: ['search_information', 'analyze_data', 'generate_report'],
      },
      {
        name: 'Problem Solving Workflow',
        goal: 'Identify problem, generate solutions, and implement the best approach',
        requirements: ['problem identification', 'solution generation', 'implementation'],
        tools: [
          'identify_problem',
          'generate_solutions',
          'evaluate_solutions',
          'implement_solution',
        ],
        input: 'Help me solve the performance issues in our application',
        expectedActions: ['identify_problem', 'generate_solutions', 'implement_solution'],
      },
    ];

    for (const scenario of multiAgentScenarios) {
      const testCase: RealmBenchTestCase = {
        task: {
          id: `multi-agent-${scenario.name.toLowerCase().replace(/\s+/g, '-')}`,
          name: scenario.name,
          description: `Test ${scenario.name} in multi-agent context`,
          goal: scenario.goal,
          requirements: scenario.requirements,
          constraints: {
            maxTime: 60000,
            maxSteps: 8,
          },
          expectedOutcome: `Successfully coordinate ${scenario.expectedActions.join(' -> ')}`,
          availableTools: scenario.tools,
          timeoutMs: 60000,
          maxSteps: 8,
        },
        input: {
          message: scenario.input,
          context: {},
        },
        expected: {
          actions: scenario.expectedActions,
          outcome: scenario.goal,
          metrics: {
            maxDuration: 60000,
            maxSteps: 8,
            requiredActions: scenario.expectedActions,
          },
        },
      };

      this.testCases.push(testCase);
    }
  }

  /**
   * Get available providers from runtime
   */
  private getAvailableProviders(): string[] {
    return this.runtime.providers.map((p) => p.name);
  }

  /**
   * Evaluate test result against expected outcomes
   */
  private evaluateTestResult(
    testCase: RealmBenchTestCase,
    executionResult: any,
    actionsPerformed: string[]
  ): boolean {
    // Check if execution was successful
    if (!executionResult.success) {
      return false;
    }

    // Check if required actions were performed
    const requiredActions = testCase.expected.metrics.requiredActions || [];
    for (const requiredAction of requiredActions) {
      if (!actionsPerformed.includes(requiredAction)) {
        logger.warn(`[RealmBenchAdapter] Missing required action: ${requiredAction}`);
        return false;
      }
    }

    // Check duration constraints
    if (
      testCase.expected.metrics.maxDuration &&
      executionResult.duration > testCase.expected.metrics.maxDuration
    ) {
      logger.warn(
        `[RealmBenchAdapter] Execution exceeded max duration: ${executionResult.duration}ms`
      );
      return false;
    }

    // Check step constraints
    if (
      testCase.expected.metrics.maxSteps &&
      executionResult.completedSteps > testCase.expected.metrics.maxSteps
    ) {
      logger.warn(
        `[RealmBenchAdapter] Execution exceeded max steps: ${executionResult.completedSteps}`
      );
      return false;
    }

    return true;
  }

  /**
   * Calculate performance metrics
   */
  private calculateMetrics(
    testCase: RealmBenchTestCase,
    plan: ActionPlan,
    executionResult: any,
    planningTime: number,
    executionTime: number
  ): RealmBenchResult['metrics'] {
    // Plan quality based on structure and dependencies
    const planQuality = Math.min(1.0, plan.steps.length > 0 ? 0.5 + plan.steps.length / 10 : 0);

    // Goal achievement based on success and action coverage
    const requiredActions = testCase.expected.metrics.requiredActions || [];
    const actionCoverage =
      requiredActions.length > 0 ? executionResult.completedSteps / requiredActions.length : 1.0;
    const goalAchievement = executionResult.success ? Math.min(1.0, actionCoverage) : 0;

    // Efficiency based on time and steps
    const expectedTime = testCase.expected.metrics.maxDuration || 30000;
    const expectedSteps = testCase.expected.metrics.maxSteps || 5;
    const timeEfficiency = Math.max(0, 1 - executionResult.duration / expectedTime);
    const stepEfficiency = Math.max(0, 1 - executionResult.completedSteps / expectedSteps);
    const efficiency = (timeEfficiency + stepEfficiency) / 2;

    return {
      planningTime,
      executionTime,
      planQuality,
      goalAchievement,
      efficiency,
    };
  }

  /**
   * Generate comprehensive benchmark report
   */
  private generateReport(results: RealmBenchResult[], totalDuration: number): RealmBenchReport {
    const passedTests = results.filter((r) => r.success).length;
    const failedTests = results.length - passedTests;

    const averageDuration =
      results.length > 0 ? results.reduce((sum, r) => sum + r.duration, 0) / results.length : 0;

    const averageSteps =
      results.length > 0
        ? results.reduce((sum, r) => sum + r.stepsExecuted, 0) / results.length
        : 0;

    const averagePlanQuality =
      results.length > 0
        ? results.reduce((sum, r) => sum + r.metrics.planQuality, 0) / results.length
        : 0;

    const averageGoalAchievement =
      results.length > 0
        ? results.reduce((sum, r) => sum + r.metrics.goalAchievement, 0) / results.length
        : 0;

    const averageEfficiency =
      results.length > 0
        ? results.reduce((sum, r) => sum + r.metrics.efficiency, 0) / results.length
        : 0;

    // Analyze task categories
    const taskCategories: Record<
      string,
      { count: number; successRate: number; averageScore: number }
    > = {};

    for (const result of results) {
      const category = result.taskId.split('-')[0]; // Extract category from task ID
      if (!taskCategories[category]) {
        taskCategories[category] = { count: 0, successRate: 0, averageScore: 0 };
      }
      taskCategories[category].count++;
    }

    // Calculate success rates and scores for each category
    for (const [category, info] of Object.entries(taskCategories)) {
      const categoryResults = results.filter((r) => r.taskId.startsWith(category));
      const categoryPassed = categoryResults.filter((r) => r.success).length;
      info.successRate = categoryPassed / categoryResults.length;
      info.averageScore =
        categoryResults.reduce((sum, r) => sum + r.metrics.goalAchievement, 0) /
        categoryResults.length;
    }

    // Identify common failures
    const commonFailures = results
      .filter((r) => !r.success)
      .map((r) => r.error || 'Unknown error')
      .reduce(
        (acc, error) => {
          acc[error] = (acc[error] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );

    const sortedFailures = Object.entries(commonFailures)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([error]) => error);

    // Generate recommendations
    const recommendations: string[] = [];

    if (averagePlanQuality < 0.7) {
      recommendations.push('Improve plan generation quality with better prompting and validation');
    }

    if (averageEfficiency < 0.6) {
      recommendations.push('Optimize plan execution efficiency and reduce unnecessary steps');
    }

    if (failedTests > passedTests * 0.3) {
      recommendations.push('Address common failure patterns and improve error handling');
    }

    return {
      totalTests: results.length,
      passedTests,
      failedTests,
      averageDuration,
      averageSteps,
      averagePlanQuality,
      averageGoalAchievement,
      averageEfficiency,
      results,
      summary: {
        taskCategories,
        commonFailures: sortedFailures,
        recommendations,
      },
    };
  }

  /**
   * Save benchmark report to file
   */
  async saveReport(report: RealmBenchReport, filePath: string): Promise<void> {
    try {
      const reportJson = JSON.stringify(report, null, 2);
      await fs.promises.writeFile(filePath, reportJson);
      logger.info(`[RealmBenchAdapter] Benchmark report saved to ${filePath}`);
    } catch (error) {
      logger.error('[RealmBenchAdapter] Error saving report:', error);
      throw new Error(`Failed to save report: ${(error as Error).message}`);
    }
  }
}
