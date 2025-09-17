import { AgentRuntime, Service } from '@elizaos/core';
import { Scenario } from './schema';
// @ts-ignore - lodash types not available
import _ from 'lodash';

type MockDefinition = NonNullable<NonNullable<Scenario['setup']>['mocks']>[0];

interface MockExecutionHistory {
  service: string;
  method: string;
  args: unknown[];
  matchedMock: MockDefinition;
  timestamp: Date;
  executionTime: number;
}

export class MockEngine {
  private originalGetService: AgentRuntime['getService'];
  private mockRegistry: Map<string, MockDefinition[]> = new Map();
  private mockHistory: MockExecutionHistory[] = [];
  private logger: {
    info: (msg: string) => void;
    debug: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };

  constructor(private runtime: AgentRuntime) {
    this.originalGetService = this.runtime.getService.bind(this.runtime);
    this.logger = runtime.logger || console;
  }

  public applyMocks(mocks: MockDefinition[] = []) {
    if (mocks.length === 0) return;

    // Build mock registry for efficient lookup
    this.mockRegistry.clear();
    for (const mock of mocks) {
      const key = `${mock.service}.${mock.method}`;
      if (!this.mockRegistry.has(key)) {
        this.mockRegistry.set(key, []);
      }
      this.mockRegistry.get(key)!.push(mock);
    }

    // Replace the original getService with our mocked version
    this.runtime.getService = <T extends Service = Service>(name: string): T | null => {
      const originalService = this.originalGetService<T>(name);

      if (!originalService) {
        return null;
      }

      // Return a proxy for the service that intercepts all method calls
      return new Proxy(originalService as object, {
        get: (target, prop: string, receiver) => {
          const key = `${name}.${prop}`;

          if (!this.mockRegistry.has(key)) {
            // No mock for this method, return the original
            return Reflect.get(target, prop, receiver);
          }

          // Return a new function that will perform the mock logic
          return async (...args: unknown[]) => {
            const potentialMocks = this.mockRegistry.get(key)!;

            // Find the best matching mock using enhanced matching strategies
            const matchedMock = await this.findBestMatchingMock(potentialMocks, args);

            if (matchedMock) {
              const startTime = Date.now();
              const result = await this.executeMock(matchedMock, args);
              const executionTime = Date.now() - startTime;

              // Record mock execution
              this.recordMockExecution(key, args, matchedMock, executionTime);

              return result;
            }

            // No matching mock found, call the original method
            return Reflect.get(target, prop, receiver)(...args);
          };
        },
      }) as unknown as T;
    };
  }

  public revertMocks() {
    // Restore the original getService method to clean up
    this.runtime.getService = this.originalGetService;
    this.mockRegistry.clear();
  }

  public getMockRegistry() {
    return this.mockRegistry;
  }

  /**
   * Find the best matching mock using enhanced matching strategies
   */
  private async findBestMatchingMock(
    mocks: MockDefinition[],
    args: unknown[]
  ): Promise<MockDefinition | null> {
    // Sort mocks by specificity (more specific conditions first)
    const sortedMocks = this.sortMocksBySpecificity(mocks);

    for (const mock of sortedMocks) {
      if (await this.matchesCondition(mock, args)) {
        return mock;
      }
    }

    return null;
  }

  /**
   * Execute a mock with enhanced features
   */
  private async executeMock(mock: MockDefinition, args: unknown[]): Promise<unknown> {
    // Handle metadata (delay, probability)
    if (mock.metadata?.delay) {
      await new Promise((resolve) => setTimeout(resolve, mock.metadata!.delay));
    }

    if (mock.metadata?.probability && Math.random() < mock.metadata.probability) {
      throw new Error('Random mock failure');
    }

    // Handle error simulation
    if (mock.error) {
      const error = new Error(`${mock.error.code}: ${mock.error.message}`);
      (error as Error & { status?: number }).status = mock.error.status;
      throw error;
    }

    // Handle dynamic response template (SECURITY FIX: No more arbitrary code execution)
    if (mock.responseFn) {
      try {
        const input = this.extractInputFromArgs(args);
        const context = this.buildRequestContext(args);
        return this.parseResponseTemplate(mock.responseFn, { args, input, context });
      } catch (error) {
        this.logger.error(`Response template error: ${error}`);
        throw error;
      }
    }

    // Return static response
    return mock.response;
  }

  /**
   * Enhanced condition matching with multiple strategies
   */
  private async matchesCondition(mock: MockDefinition, args: unknown[]): Promise<boolean> {
    if (!mock.when) return true; // Generic mock

    const input = this.extractInputFromArgs(args);
    const context = this.buildRequestContext(args);

    // 1. Exact argument matching (existing)
    if (mock.when.args) {
      if (!_.isEqual(args, mock.when.args)) {
        return false;
      }
    }

    // 2. Input parameter matching
    if (mock.when.input) {
      if (!this.matchesInput(input, mock.when.input)) {
        return false;
      }
    }

    // 3. Context matching
    if (mock.when.context) {
      if (!this.matchesContext(context, mock.when.context)) {
        return false;
      }
    }

    // 4. Custom matcher template (SECURITY FIX: No more arbitrary code execution)
    if (mock.when.matcher) {
      try {
        const result = this.evaluateTemplate(mock.when.matcher, { args, input, context });
        if (!result) {
          return false;
        }
      } catch (error) {
        this.logger.error(`Matcher template error: ${error}`);
        return false;
      }
    }

    // 5. Partial argument matching
    if (mock.when.partialArgs) {
      if (!this.matchesPartialArgs(args, mock.when.partialArgs)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Extract input parameters from method arguments
   */
  private extractInputFromArgs(args: unknown[]): Record<string, unknown> {
    const input: Record<string, unknown> = {};

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (typeof arg === 'object' && arg !== null) {
        Object.assign(input, arg);
      } else if (typeof arg === 'string' || typeof arg === 'number') {
        input[`arg${i}`] = arg;
      }
    }

    return input;
  }

  /**
   * Build request context for matching
   */
  private buildRequestContext(args: unknown[]): Record<string, unknown> {
    return {
      timestamp: new Date().toISOString(),
      argsCount: args.length,
      hasObjectArgs: args.some((arg) => typeof arg === 'object'),
    };
  }

  /**
   * Sort mocks by specificity (more specific conditions first)
   */
  private sortMocksBySpecificity(mocks: MockDefinition[]): MockDefinition[] {
    return mocks.sort((a, b) => {
      const aSpecificity = this.calculateSpecificity(a);
      const bSpecificity = this.calculateSpecificity(b);
      return bSpecificity - aSpecificity; // Descending order
    });
  }

  private calculateSpecificity(mock: MockDefinition): number {
    let score = 0;
    if (mock.when) {
      if (mock.when.args) score += 10;
      if (mock.when.input) score += 8;
      if (mock.when.context) score += 6;
      if (mock.when.matcher) score += 4;
      if (mock.when.partialArgs) score += 2;
    }
    return score;
  }

  /**
   * Match input parameters
   */
  private matchesInput(input: Record<string, any>, expectedInput: Record<string, any>): boolean {
    for (const [key, value] of Object.entries(expectedInput)) {
      if (!_.isEqual(input[key], value)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Match context parameters
   */
  private matchesContext(
    context: Record<string, any>,
    expectedContext: Record<string, any>
  ): boolean {
    for (const [key, value] of Object.entries(expectedContext)) {
      if (!_.isEqual(context[key], value)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Match partial arguments
   */
  private matchesPartialArgs(args: unknown[], partialArgs: unknown[]): boolean {
    if (args.length < partialArgs.length) return false;

    for (let i = 0; i < partialArgs.length; i++) {
      if (!_.isEqual(args[i], partialArgs[i])) {
        return false;
      }
    }
    return true;
  }

  /**
   * Record mock execution for history and debugging
   */
  private recordMockExecution(
    serviceMethod: string,
    args: unknown[],
    mock: MockDefinition,
    executionTime: number
  ): void {
    const historyEntry: MockExecutionHistory = {
      service: serviceMethod.split('.')[0],
      method: serviceMethod.split('.')[1],
      args,
      matchedMock: mock,
      timestamp: new Date(),
      executionTime,
    };

    this.mockHistory.push(historyEntry);

    this.logger.info(`Mock triggered: ${serviceMethod}`);
    this.logger.debug(`  Condition: ${JSON.stringify(mock.when)}`);
    this.logger.debug(`  Args: ${JSON.stringify(args)}`);
    this.logger.debug(`  Execution time: ${executionTime}ms`);

    if (mock.responseFn) {
      this.logger.debug(`  Using dynamic response function`);
    } else if (mock.error) {
      this.logger.debug(`  Simulating error: ${mock.error.code}`);
    } else {
      this.logger.debug(`  Using static response`);
    }
  }

  /**
   * Get mock execution history
   */
  public getMockHistory(): MockExecutionHistory[] {
    return [...this.mockHistory];
  }

  /**
   * Clear mock history
   */
  public clearMockHistory(): void {
    this.mockHistory = [];
  }

  /**
   * Get mock statistics
   */
  public getMockStatistics(): { totalExecutions: number; averageExecutionTime: number } {
    if (this.mockHistory.length === 0) {
      return { totalExecutions: 0, averageExecutionTime: 0 };
    }

    const totalExecutions = this.mockHistory.length;
    const totalTime = this.mockHistory.reduce((sum, entry) => sum + entry.executionTime, 0);
    const averageExecutionTime = totalTime / totalExecutions;

    return { totalExecutions, averageExecutionTime };
  }

  /**
   * Parse response template with safe variable interpolation
   * SECURITY: Only allows predefined variables, no arbitrary code execution
   */
  private parseResponseTemplate(
    template: string,
    variables: { args: unknown[]; input: Record<string, unknown>; context: Record<string, unknown> }
  ): unknown {
    // Handle JSON response templates
    if (template.trim().startsWith('{') || template.trim().startsWith('[')) {
      try {
        return JSON.parse(this.interpolateTemplate(template, variables));
      } catch (error) {
        this.logger.error(`Failed to parse JSON template: ${error}`);
        throw new Error('Invalid JSON template');
      }
    }

    // Handle string templates
    return this.interpolateTemplate(template, variables);
  }

  /**
   * Evaluate template for boolean conditions
   * SECURITY: Only allows safe comparison operations, no arbitrary code execution
   */
  private evaluateTemplate(
    template: string,
    variables: { args: unknown[]; input: Record<string, unknown>; context: Record<string, unknown> }
  ): boolean {
    // Simple boolean template evaluation with safe operations
    // Supports patterns like: "${input.type} === 'test'" or "${args[0]} > 10"
    const interpolated = this.interpolateTemplate(template, variables);

    // Parse simple boolean expressions safely
    try {
      // Only allow safe comparison operations
      const safeExpression = interpolated.replace(/[^\w\s===!<>()\[\]\.'"]/g, '');

      // Basic pattern matching for simple comparisons
      const comparisonRegex = /^\s*(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+?)\s*$/;
      const match = safeExpression.match(comparisonRegex);

      if (match) {
        const [, left, operator, right] = match;
        return this.performSafeComparison(left.trim(), operator, right.trim());
      }

      // For non-comparison expressions, check if it's truthy
      return Boolean(interpolated && interpolated !== 'false' && interpolated !== '0');
    } catch (error) {
      this.logger.error(`Template evaluation error: ${error}`);
      return false;
    }
  }

  /**
   * Perform safe string interpolation
   * SECURITY: Only allows access to whitelisted variables
   */
  private interpolateTemplate(
    template: string,
    variables: { args: unknown[]; input: Record<string, unknown>; context: Record<string, unknown> }
  ): string {
    return template.replace(/\$\{([^}]+)\}/g, (match, expression) => {
      try {
        const value = this.resolveTemplateVariable(expression.trim(), variables);
        return String(value);
      } catch (error) {
        this.logger.warn(`Failed to resolve template variable: ${expression}`);
        return match; // Return original if resolution fails
      }
    });
  }

  /**
   * Resolve template variables safely
   * SECURITY: Only allows access to predefined variable paths
   */
  private resolveTemplateVariable(
    expression: string,
    variables: { args: unknown[]; input: Record<string, unknown>; context: Record<string, unknown> }
  ): unknown {
    // Handle array access like args[0], args[1], etc.
    if (expression.startsWith('args[') && expression.endsWith(']')) {
      const indexStr = expression.slice(5, -1);
      const index = parseInt(indexStr, 10);
      if (!isNaN(index) && index >= 0 && index < variables.args.length) {
        return variables.args[index];
      }
      return undefined;
    }

    // Handle object property access like input.prop, context.prop
    const parts = expression.split('.');
    if (parts.length >= 2) {
      const rootVar = parts[0];
      const propertyPath = parts.slice(1);

      let current: unknown;
      switch (rootVar) {
        case 'input':
          current = variables.input;
          break;
        case 'context':
          current = variables.context;
          break;
        case 'args':
          current = variables.args;
          break;
        default:
          throw new Error(`Unauthorized variable access: ${rootVar}`);
      }

      // Navigate the property path safely
      for (const prop of propertyPath) {
        if (current && typeof current === 'object' && prop in current) {
          current = (current as any)[prop];
        } else {
          return undefined;
        }
      }

      return current;
    }

    // Handle direct variable access
    switch (expression) {
      case 'args':
        return variables.args;
      case 'input':
        return variables.input;
      case 'context':
        return variables.context;
      default:
        throw new Error(`Unauthorized variable access: ${expression}`);
    }
  }

  /**
   * Perform safe comparison operations
   * SECURITY: Only allows whitelisted comparison operators
   */
  private performSafeComparison(left: string, operator: string, right: string): boolean {
    // Remove quotes if present
    const cleanLeft = left.replace(/^['"]|['"]$/g, '');
    const cleanRight = right.replace(/^['"]|['"]$/g, '');

    // Try to parse as numbers if possible
    const leftNum = parseFloat(cleanLeft);
    const rightNum = parseFloat(cleanRight);
    const leftIsNum = !isNaN(leftNum);
    const rightIsNum = !isNaN(rightNum);

    // Use numeric comparison if both are numbers
    const leftVal = leftIsNum ? leftNum : cleanLeft;
    const rightVal = rightIsNum ? rightNum : cleanRight;

    switch (operator) {
      case '===':
      case '==':
        return leftVal === rightVal;
      case '!==':
      case '!=':
        return leftVal !== rightVal;
      case '>=':
        return leftIsNum && rightIsNum ? leftNum >= rightNum : String(leftVal) >= String(rightVal);
      case '<=':
        return leftIsNum && rightIsNum ? leftNum <= rightNum : String(leftVal) <= String(rightVal);
      case '>':
        return leftIsNum && rightIsNum ? leftNum > rightNum : String(leftVal) > String(rightVal);
      case '<':
        return leftIsNum && rightIsNum ? leftNum < rightNum : String(leftVal) < String(rightVal);
      default:
        throw new Error(`Unsupported comparison operator: ${operator}`);
    }
  }
}
