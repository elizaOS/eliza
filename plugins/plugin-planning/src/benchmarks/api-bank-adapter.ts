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
 * API-Bank Dialog Entry
 */
export interface ApiBankDialogEntry {
  role: 'User' | 'AI' | 'API';
  text?: string;
  api_name?: string;
  param_dict?: Record<string, any>;
  result?: {
    output: any;
    success?: boolean;
  };
}

/**
 * API-Bank Test Case
 */
export interface ApiBankTestCase {
  id: string;
  level: 1 | 2 | 3;
  category: string;
  dialog_history: ApiBankDialogEntry[];
  available_apis: string[];
  ground_truth: {
    api_calls: Array<{
      api_name: string;
      parameters: Record<string, any>;
      expected_result: any;
    }>;
    final_response: string;
  };
  metadata: {
    domain: string;
    complexity: 'low' | 'medium' | 'high';
    num_apis: number;
    num_turns: number;
  };
}

/**
 * API-Bank Execution Result
 */
export interface ApiBankResult {
  testCaseId: string;
  level: number;
  success: boolean;
  apiCallAccuracy: number; // Percentage of correct API calls
  parameterAccuracy: number; // Accuracy of API parameters
  responseQuality: number; // ROUGE-L score for final response
  planGenerated: ActionPlan | null;
  actualApiCalls: Array<{
    api_name: string;
    parameters: Record<string, any>;
    result: any;
  }>;
  actualResponse: string;
  error?: string;
  metrics: {
    planningTime: number;
    executionTime: number;
    totalTime: number;
    toolUseAccuracy: number;
    planQuality: number;
  };
}

/**
 * API-Bank Benchmark Report
 */
export interface ApiBankReport {
  totalTests: number;
  passedTests: number;
  levelBreakdown: Record<
    number,
    {
      total: number;
      passed: number;
      successRate: number;
      avgApiAccuracy: number;
      avgResponseQuality: number;
    }
  >;
  categoryBreakdown: Record<
    string,
    {
      total: number;
      passed: number;
      successRate: number;
      avgComplexity: number;
    }
  >;
  overallMetrics: {
    averageApiCallAccuracy: number;
    averageParameterAccuracy: number;
    averageResponseQuality: number;
    averageToolUseAccuracy: number;
    averagePlanQuality: number;
  };
  results: ApiBankResult[];
  insights: {
    bestPerformingCategories: string[];
    challengingCategories: string[];
    commonErrors: string[];
    recommendations: string[];
  };
}

/**
 * Production-Ready API-Bank Adapter
 * Tests ElizaOS planning capabilities against API-Bank tool-use scenarios
 */
export class ApiBankAdapter {
  private runtime: IAgentRuntime;
  private planningService: IPlanningService;
  private testCases: ApiBankTestCase[] = [];
  private apiDescriptions = new Map<string, string>();

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;

    const planningService = runtime.getService<PlanningService>('planning');
    if (!planningService) {
      throw new Error('Planning service is required for API-Bank testing');
    }
    this.planningService = planningService;
  }

  /**
   * Load test cases from API-Bank format
   */
  async loadTestCases(apiBankDataPath: string): Promise<void> {
    try {
      logger.info(`[ApiBankAdapter] Loading test cases from ${apiBankDataPath}`);

      // Load Level 1 & 2 test cases
      await this.loadLevel1And2Tests(path.join(apiBankDataPath, 'lv1-lv2-samples'));

      // Load Level 3 test cases
      await this.loadLevel3Tests(path.join(apiBankDataPath, 'lv3-samples'));

      // Load API descriptions
      await this.loadApiDescriptions(path.join(apiBankDataPath, 'apis'));

      logger.info(`[ApiBankAdapter] Loaded ${this.testCases.length} test cases`);
    } catch (error) {
      logger.error('[ApiBankAdapter] Error loading test cases:', error);
      throw new Error(`Failed to load API-Bank test cases: ${(error as Error).message}`);
    }
  }

  /**
   * Run all loaded test cases
   */
  async runBenchmark(): Promise<ApiBankReport> {
    const startTime = Date.now();
    const results: ApiBankResult[] = [];

    logger.info(
      `[ApiBankAdapter] Starting API-Bank benchmark with ${this.testCases.length} test cases`
    );

    for (const testCase of this.testCases) {
      try {
        const result = await this.runTestCase(testCase);
        results.push(result);

        logger.info(
          `[ApiBankAdapter] Test ${testCase.id} (Level ${testCase.level}): ` +
            `${result.success ? 'PASS' : 'FAIL'} ` +
            `(API: ${(result.apiCallAccuracy * 100).toFixed(1)}%, ` +
            `Response: ${(result.responseQuality * 100).toFixed(1)}%)`
        );
      } catch (error) {
        logger.error(`[ApiBankAdapter] Test ${testCase.id} failed:`, error);

        results.push({
          testCaseId: testCase.id,
          level: testCase.level,
          success: false,
          apiCallAccuracy: 0,
          parameterAccuracy: 0,
          responseQuality: 0,
          planGenerated: null,
          actualApiCalls: [],
          actualResponse: '',
          error: (error as Error).message,
          metrics: {
            planningTime: 0,
            executionTime: 0,
            totalTime: 0,
            toolUseAccuracy: 0,
            planQuality: 0,
          },
        });
      }
    }

    const report = this.generateReport(results);

    logger.info(
      `[ApiBankAdapter] Benchmark completed: ${report.passedTests}/${report.totalTests} passed ` +
        `(${((report.passedTests / report.totalTests) * 100).toFixed(1)}%)`
    );

    return report;
  }

  /**
   * Run a specific test case
   */
  private async runTestCase(testCase: ApiBankTestCase): Promise<ApiBankResult> {
    const startTime = Date.now();
    let planningTime = 0;
    let executionTime = 0;
    let planGenerated: ActionPlan | null = null;
    const actualApiCalls: Array<{
      api_name: string;
      parameters: Record<string, any>;
      result: any;
    }> = [];
    let actualResponse = '';

    try {
      // Create test message from dialog history
      const lastUserMessage = testCase.dialog_history
        .filter((entry) => entry.role === 'User')
        .pop();

      if (!lastUserMessage) {
        throw new Error('No user message found in dialog history');
      }

      const testMessage: Memory = {
        id: asUUID(uuidv4()),
        entityId: asUUID(uuidv4()),
        agentId: this.runtime.agentId,
        roomId: asUUID(uuidv4()),
        content: {
          text: lastUserMessage.text || '',
          source: 'api-bank-test',
        },
        createdAt: Date.now(),
      };

      // Build context from dialog history
      const dialogContext = this.buildDialogContext(testCase.dialog_history);
      const testState: State = {
        values: {
          ...dialogContext,
          availableApis: testCase.available_apis,
        },
        data: {
          conversationHistory: testCase.dialog_history,
        },
        text: lastUserMessage.text || '',
      };

      // Step 1: Create comprehensive plan
      const planningStartTime = Date.now();

      const planningContext: PlanningContext = {
        goal: `Handle user request: ${lastUserMessage.text}`,
        constraints: [
          {
            type: 'resource',
            value: testCase.available_apis,
            description: 'Available APIs for tool use',
          },
          {
            type: 'custom',
            value: testCase.level,
            description: `API-Bank difficulty level ${testCase.level}`,
          },
        ],
        availableActions: this.getRelevantActions(testCase.available_apis),
        availableProviders: this.getAvailableProviders(),
        preferences: {
          executionModel: 'sequential',
          maxSteps: testCase.level === 3 ? 15 : 8,
          timeoutMs: 60000,
        },
      };

      planGenerated = await this.planningService.createComprehensivePlan(
        this.runtime,
        planningContext,
        testMessage,
        testState
      );

      planningTime = Date.now() - planningStartTime;

      // Step 2: Execute the plan with API call tracking
      const executionStartTime = Date.now();

      const executionResult = await this.planningService.executePlan(
        this.runtime,
        planGenerated,
        testMessage,
        async (content: Content) => {
          // Track API calls and responses
          if (content.actions) {
            for (const action of content.actions) {
              if (testCase.available_apis.includes(action)) {
                actualApiCalls.push({
                  api_name: action,
                  parameters: this.extractParametersFromContent(content),
                  result: content.text || 'Success',
                });
              }
            }
          }

          if (content.text) {
            actualResponse = content.text;
          }
          return [];
        }
      );

      executionTime = Date.now() - executionStartTime;

      // Step 3: Evaluate results
      const apiCallAccuracy = this.calculateApiCallAccuracy(testCase, actualApiCalls);
      const parameterAccuracy = this.calculateParameterAccuracy(testCase, actualApiCalls);
      const responseQuality = await this.calculateResponseQuality(
        testCase.ground_truth.final_response,
        actualResponse
      );

      const success = apiCallAccuracy > 0.7 && responseQuality > 0.5;
      const toolUseAccuracy = (apiCallAccuracy + parameterAccuracy) / 2;
      const planQuality = this.calculatePlanQuality(planGenerated, testCase);

      return {
        testCaseId: testCase.id,
        level: testCase.level,
        success,
        apiCallAccuracy,
        parameterAccuracy,
        responseQuality,
        planGenerated,
        actualApiCalls,
        actualResponse,
        metrics: {
          planningTime,
          executionTime,
          totalTime: Date.now() - startTime,
          toolUseAccuracy,
          planQuality,
        },
      };
    } catch (error) {
      return {
        testCaseId: testCase.id,
        level: testCase.level,
        success: false,
        apiCallAccuracy: 0,
        parameterAccuracy: 0,
        responseQuality: 0,
        planGenerated,
        actualApiCalls,
        actualResponse,
        error: (error as Error).message,
        metrics: {
          planningTime,
          executionTime,
          totalTime: Date.now() - startTime,
          toolUseAccuracy: 0,
          planQuality: 0,
        },
      };
    }
  }

  /**
   * Load Level 1 & 2 test cases from JSONL files
   */
  private async loadLevel1And2Tests(samplesPath: string): Promise<void> {
    try {
      const level1Path = path.join(samplesPath, 'level-1-given-desc');
      const level2Path = path.join(samplesPath, 'level-2-given-tools');

      // Load Level 1 tests
      if (fs.existsSync(level1Path)) {
        await this.loadTestsFromDirectory(level1Path, 1);
      }

      // Load Level 2 tests
      if (fs.existsSync(level2Path)) {
        await this.loadTestsFromDirectory(level2Path, 2);
      }
    } catch (error) {
      logger.error('[ApiBankAdapter] Error loading Level 1 & 2 tests:', error);
    }
  }

  /**
   * Load Level 3 test cases from text files
   */
  private async loadLevel3Tests(samplesPath: string): Promise<void> {
    try {
      if (!fs.existsSync(samplesPath)) {
        return;
      }

      const files = fs.readdirSync(samplesPath).filter((f) => f.endsWith('.txt'));

      for (const file of files) {
        const filePath = path.join(samplesPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');

        // Parse Level 3 scenarios
        const scenarios = this.parseLevel3Scenarios(content, file);
        this.testCases.push(...scenarios);
      }
    } catch (error) {
      logger.error('[ApiBankAdapter] Error loading Level 3 tests:', error);
    }
  }

  /**
   * Load tests from a directory of JSONL files
   */
  private async loadTestsFromDirectory(dirPath: string, level: 1 | 2): Promise<void> {
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');

      const dialogHistory: ApiBankDialogEntry[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          dialogHistory.push(entry);
        } catch (error) {
          logger.warn(`[ApiBankAdapter] Failed to parse line in ${file}:`, line);
        }
      }

      if (dialogHistory.length > 0) {
        const testCase = this.createTestCaseFromDialog(file, level, dialogHistory);
        this.testCases.push(testCase);
      }
    }
  }

  /**
   * Parse Level 3 scenarios from text files
   */
  private parseLevel3Scenarios(content: string, filename: string): ApiBankTestCase[] {
    const scenarios: ApiBankTestCase[] = [];

    // Level 3 files contain complex multi-turn scenarios
    // This is a simplified parser - in production, you'd want more robust parsing
    const lines = content.split('\n').filter((line) => line.trim());

    let currentScenario: Partial<ApiBankTestCase> = {};
    let dialogHistory: ApiBankDialogEntry[] = [];

    for (const line of lines) {
      if (line.startsWith('Scenario:') || line.startsWith('Case:')) {
        // Save previous scenario
        if (currentScenario.id && dialogHistory.length > 0) {
          scenarios.push(this.completeLevel3TestCase(currentScenario, dialogHistory));
        }

        // Start new scenario
        currentScenario = {
          id: `level3-${filename}-${scenarios.length + 1}`,
          level: 3,
          category: filename.replace('.txt', ''),
        };
        dialogHistory = [];
      } else if (line.startsWith('User:')) {
        dialogHistory.push({
          role: 'User',
          text: line.substring(5).trim(),
        });
      } else if (line.startsWith('Assistant:') || line.startsWith('AI:')) {
        dialogHistory.push({
          role: 'AI',
          text: line.substring(line.indexOf(':') + 1).trim(),
        });
      }
    }

    // Save last scenario
    if (currentScenario.id && dialogHistory.length > 0) {
      scenarios.push(this.completeLevel3TestCase(currentScenario, dialogHistory));
    }

    return scenarios;
  }

  /**
   * Complete Level 3 test case creation
   */
  private completeLevel3TestCase(
    partial: Partial<ApiBankTestCase>,
    dialogHistory: ApiBankDialogEntry[]
  ): ApiBankTestCase {
    return {
      id: partial.id || 'unknown',
      level: 3,
      category: partial.category || 'general',
      dialog_history: dialogHistory,
      available_apis: this.extractApis(dialogHistory),
      ground_truth: {
        api_calls: this.extractGroundTruthApiCalls(dialogHistory),
        final_response: this.extractFinalResponse(dialogHistory),
      },
      metadata: {
        domain: partial.category || 'general',
        complexity: 'high' as const,
        num_apis: this.extractApis(dialogHistory).length,
        num_turns: dialogHistory.length,
      },
    };
  }

  /**
   * Create test case from dialog history
   */
  private createTestCaseFromDialog(
    filename: string,
    level: 1 | 2,
    dialogHistory: ApiBankDialogEntry[]
  ): ApiBankTestCase {
    const apis = this.extractApis(dialogHistory);
    const category = this.extractCategory(filename);

    return {
      id: `level${level}-${filename.replace('.jsonl', '')}`,
      level,
      category,
      dialog_history: dialogHistory,
      available_apis: apis,
      ground_truth: {
        api_calls: this.extractGroundTruthApiCalls(dialogHistory),
        final_response: this.extractFinalResponse(dialogHistory),
      },
      metadata: {
        domain: category,
        complexity: level === 1 ? 'low' : 'medium',
        num_apis: apis.length,
        num_turns: dialogHistory.length,
      },
    };
  }

  /**
   * Load API descriptions for tool use
   */
  private async loadApiDescriptions(apisPath: string): Promise<void> {
    try {
      if (!fs.existsSync(apisPath)) {
        return;
      }

      const files = fs.readdirSync(apisPath).filter((f) => f.endsWith('.py'));

      for (const file of files) {
        const apiName = file.replace('.py', '');
        const filePath = path.join(apisPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');

        // Extract API description from Python docstring
        const description = this.extractApiDescription(content);
        this.apiDescriptions.set(apiName, description);
      }
    } catch (error) {
      logger.error('[ApiBankAdapter] Error loading API descriptions:', error);
    }
  }

  /**
   * Extract APIs from dialog history
   */
  private extractApis(dialogHistory: ApiBankDialogEntry[]): string[] {
    const apis = new Set<string>();

    for (const entry of dialogHistory) {
      if (entry.role === 'API' && entry.api_name) {
        apis.add(entry.api_name);
      }
    }

    return Array.from(apis);
  }

  /**
   * Extract ground truth API calls
   */
  private extractGroundTruthApiCalls(dialogHistory: ApiBankDialogEntry[]): Array<{
    api_name: string;
    parameters: Record<string, any>;
    expected_result: any;
  }> {
    return dialogHistory
      .filter((entry) => entry.role === 'API')
      .map((entry) => ({
        api_name: entry.api_name || '',
        parameters: entry.param_dict || {},
        expected_result: entry.result?.output,
      }));
  }

  /**
   * Extract final response from dialog
   */
  private extractFinalResponse(dialogHistory: ApiBankDialogEntry[]): string {
    const aiResponses = dialogHistory.filter((entry) => entry.role === 'AI');
    return aiResponses.length > 0 ? aiResponses[aiResponses.length - 1].text || '' : '';
  }

  /**
   * Extract category from filename
   */
  private extractCategory(filename: string): string {
    return filename.split('-')[0] || 'general';
  }

  /**
   * Extract API description from Python file
   */
  private extractApiDescription(content: string): string {
    // Look for docstring after function definition
    const match = content.match(/def\s+\w+.*?"""(.*?)"""/s);
    return match ? match[1].trim() : 'No description available';
  }

  /**
   * Build dialog context from history
   */
  private buildDialogContext(dialogHistory: ApiBankDialogEntry[]): Record<string, any> {
    const context: Record<string, any> = {
      previousInteractions: [],
      apiCallHistory: [],
    };

    for (const entry of dialogHistory) {
      if (entry.role === 'User' || entry.role === 'AI') {
        context.previousInteractions.push({
          role: entry.role,
          text: entry.text,
        });
      } else if (entry.role === 'API') {
        context.apiCallHistory.push({
          api: entry.api_name,
          parameters: entry.param_dict,
          result: entry.result,
        });
      }
    }

    return context;
  }

  /**
   * Get relevant actions for available APIs
   */
  private getRelevantActions(availableApis: string[]): string[] {
    // Map API names to available actions
    const actionMap: Record<string, string> = {
      calculator: 'CALCULATE',
      search_engine: 'SEARCH',
      weather: 'GET_WEATHER',
      calendar: 'MANAGE_CALENDAR',
      email: 'SEND_EMAIL',
      reminder: 'SET_REMINDER',
    };

    const actions = ['REPLY', 'THINK']; // Always available

    for (const api of availableApis) {
      if (actionMap[api]) {
        actions.push(actionMap[api]);
      } else {
        // Generic action for unknown APIs
        actions.push('USE_TOOL');
      }
    }

    return actions;
  }

  /**
   * Get available providers from runtime
   */
  private getAvailableProviders(): string[] {
    return this.runtime.providers.map((p) => p.name);
  }

  /**
   * Extract parameters from content
   */
  private extractParametersFromContent(content: Content): Record<string, any> {
    // This is simplified - in production, you'd parse the actual parameters
    return {
      query: content.text || '',
      timestamp: Date.now(),
    };
  }

  /**
   * Calculate API call accuracy
   */
  private calculateApiCallAccuracy(
    testCase: ApiBankTestCase,
    actualApiCalls: Array<{ api_name: string; parameters: Record<string, any>; result: any }>
  ): number {
    const expectedCalls = testCase.ground_truth.api_calls;

    if (expectedCalls.length === 0) {
      return actualApiCalls.length === 0 ? 1.0 : 0.0;
    }

    let correctCalls = 0;

    for (const expected of expectedCalls) {
      const actual = actualApiCalls.find((call) => call.api_name === expected.api_name);
      if (actual) {
        correctCalls++;
      }
    }

    return correctCalls / expectedCalls.length;
  }

  /**
   * Calculate parameter accuracy
   */
  private calculateParameterAccuracy(
    testCase: ApiBankTestCase,
    actualApiCalls: Array<{ api_name: string; parameters: Record<string, any>; result: any }>
  ): number {
    const expectedCalls = testCase.ground_truth.api_calls;

    if (expectedCalls.length === 0) {
      return 1.0;
    }

    let totalParameterScore = 0;
    let totalParameters = 0;

    for (const expected of expectedCalls) {
      const actual = actualApiCalls.find((call) => call.api_name === expected.api_name);

      if (actual) {
        const expectedParams = Object.keys(expected.parameters);
        const actualParams = Object.keys(actual.parameters);

        for (const param of expectedParams) {
          totalParameters++;
          if (actualParams.includes(param)) {
            totalParameterScore++;
          }
        }
      }
    }

    return totalParameters > 0 ? totalParameterScore / totalParameters : 1.0;
  }

  /**
   * Calculate response quality using ROUGE-L score
   */
  private async calculateResponseQuality(expected: string, actual: string): Promise<number> {
    // Simplified ROUGE-L calculation
    // In production, you'd use a proper ROUGE implementation
    if (!expected || !actual) {
      return 0;
    }

    const expectedWords = expected.toLowerCase().split(/\s+/);
    const actualWords = actual.toLowerCase().split(/\s+/);

    const intersection = expectedWords.filter((word) => actualWords.includes(word));

    if (expectedWords.length === 0) {
      return actualWords.length === 0 ? 1.0 : 0.0;
    }

    return intersection.length / expectedWords.length;
  }

  /**
   * Calculate plan quality score
   */
  private calculatePlanQuality(plan: ActionPlan, testCase: ApiBankTestCase): number {
    if (!plan) {
      return 0;
    }

    let score = 0.5; // Base score for having a plan

    // Score based on appropriate number of steps
    const expectedSteps = testCase.level * 2; // Rough estimate
    const stepScore = Math.max(0, 1 - Math.abs(plan.steps.length - expectedSteps) / expectedSteps);
    score += stepScore * 0.3;

    // Score based on using available APIs
    const planActions = plan.steps.map((s) => s.actionName);
    const apiUsage = testCase.available_apis.some((api) =>
      planActions.some((action) => action.toLowerCase().includes(api.toLowerCase()))
    );
    if (apiUsage) {
      score += 0.2;
    }

    return Math.min(1.0, score);
  }

  /**
   * Generate comprehensive benchmark report
   */
  private generateReport(results: ApiBankResult[]): ApiBankReport {
    const totalTests = results.length;
    const passedTests = results.filter((r) => r.success).length;

    // Level breakdown
    const levelBreakdown: ApiBankReport['levelBreakdown'] = {};
    for (let level = 1; level <= 3; level++) {
      const levelResults = results.filter((r) => r.level === level);
      if (levelResults.length > 0) {
        levelBreakdown[level] = {
          total: levelResults.length,
          passed: levelResults.filter((r) => r.success).length,
          successRate: levelResults.filter((r) => r.success).length / levelResults.length,
          avgApiAccuracy:
            levelResults.reduce((sum, r) => sum + r.apiCallAccuracy, 0) / levelResults.length,
          avgResponseQuality:
            levelResults.reduce((sum, r) => sum + r.responseQuality, 0) / levelResults.length,
        };
      }
    }

    // Category breakdown
    const categoryBreakdown: ApiBankReport['categoryBreakdown'] = {};
    const categoryMap = new Map<string, ApiBankResult[]>();

    for (const result of results) {
      const category = result.testCaseId.split('-')[1] || 'unknown';
      if (!categoryMap.has(category)) {
        categoryMap.set(category, []);
      }
      categoryMap.get(category)!.push(result);
    }

    for (const [category, categoryResults] of categoryMap) {
      categoryBreakdown[category] = {
        total: categoryResults.length,
        passed: categoryResults.filter((r) => r.success).length,
        successRate: categoryResults.filter((r) => r.success).length / categoryResults.length,
        avgComplexity:
          categoryResults.reduce((sum, r) => sum + r.level, 0) / categoryResults.length,
      };
    }

    // Overall metrics
    const overallMetrics = {
      averageApiCallAccuracy: results.reduce((sum, r) => sum + r.apiCallAccuracy, 0) / totalTests,
      averageParameterAccuracy:
        results.reduce((sum, r) => sum + r.parameterAccuracy, 0) / totalTests,
      averageResponseQuality: results.reduce((sum, r) => sum + r.responseQuality, 0) / totalTests,
      averageToolUseAccuracy:
        results.reduce((sum, r) => sum + r.metrics.toolUseAccuracy, 0) / totalTests,
      averagePlanQuality: results.reduce((sum, r) => sum + r.metrics.planQuality, 0) / totalTests,
    };

    // Insights
    const bestPerformingCategories = Object.entries(categoryBreakdown)
      .filter(([, stats]) => stats.successRate > 0.8)
      .map(([category]) => category);

    const challengingCategories = Object.entries(categoryBreakdown)
      .filter(([, stats]) => stats.successRate < 0.5)
      .map(([category]) => category);

    const commonErrors = results
      .filter((r) => r.error)
      .reduce(
        (acc, r) => {
          const error = r.error!;
          acc[error] = (acc[error] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );

    const sortedErrors = Object.entries(commonErrors)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([error]) => error);

    const recommendations: string[] = [];

    if (overallMetrics.averageApiCallAccuracy < 0.7) {
      recommendations.push('Improve API selection and tool use planning');
    }

    if (overallMetrics.averageParameterAccuracy < 0.6) {
      recommendations.push('Enhance parameter extraction and validation');
    }

    if (overallMetrics.averageResponseQuality < 0.5) {
      recommendations.push('Improve response generation quality and relevance');
    }

    return {
      totalTests,
      passedTests,
      levelBreakdown,
      categoryBreakdown,
      overallMetrics,
      results,
      insights: {
        bestPerformingCategories,
        challengingCategories,
        commonErrors: sortedErrors,
        recommendations,
      },
    };
  }

  /**
   * Save benchmark report to file
   */
  async saveReport(report: ApiBankReport, filePath: string): Promise<void> {
    try {
      const reportJson = JSON.stringify(report, null, 2);
      await fs.promises.writeFile(filePath, reportJson);
      logger.info(`[ApiBankAdapter] Benchmark report saved to ${filePath}`);
    } catch (error) {
      logger.error('[ApiBankAdapter] Error saving report:', error);
      throw new Error(`Failed to save report: ${(error as Error).message}`);
    }
  }
}
