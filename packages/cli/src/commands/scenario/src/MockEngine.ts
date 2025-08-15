import { AgentRuntime } from '@elizaos/core';
import { Scenario } from './schema';
import _ from 'lodash';

type MockDefinition = NonNullable<NonNullable<Scenario['setup']>['mocks']>[0];

interface MockExecutionHistory {
    service: string;
    method: string;
    args: any[];
    matchedMock: MockDefinition;
    timestamp: Date;
    executionTime: number;
}

export class MockEngine {
    private originalGetService: AgentRuntime['getService'];
    private mockRegistry: Map<string, MockDefinition[]> = new Map();
    private mockHistory: MockExecutionHistory[] = [];
    private logger: any;

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
        this.runtime.getService = <T>(name: string): T => {
            const originalService = this.originalGetService<T>(name);

            // Return a proxy for the service that intercepts all method calls
            return new Proxy(originalService as any, {
                get: (target, prop: string, receiver) => {
                    const key = `${name}.${prop}`;

                    if (!this.mockRegistry.has(key)) {
                        // No mock for this method, return the original
                        return Reflect.get(target, prop, receiver);
                    }

                    // Return a new function that will perform the mock logic
                    return async (...args: any[]) => {
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
            }) as T;
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
    private async findBestMatchingMock(mocks: MockDefinition[], args: any[]): Promise<MockDefinition | null> {
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
    private async executeMock(mock: MockDefinition, args: any[]): Promise<any> {
        // Handle metadata (delay, probability)
        if (mock.metadata?.delay) {
            await new Promise(resolve => setTimeout(resolve, mock.metadata.delay));
        }

        if (mock.metadata?.probability && Math.random() < mock.metadata.probability) {
            throw new Error('Random mock failure');
        }

        // Handle error simulation
        if (mock.error) {
            const error = new Error(`${mock.error.code}: ${mock.error.message}`);
            (error as any).status = mock.error.status;
            throw error;
        }

        // Handle dynamic response function
        if (mock.responseFn) {
            try {
                const responseFn = new Function('args', 'input', 'context', mock.responseFn);
                const input = this.extractInputFromArgs(args);
                const context = this.buildRequestContext(args);
                return responseFn(args, input, context);
            } catch (error) {
                this.logger.error(`Response function error: ${error}`);
                throw error;
            }
        }

        // Return static response
        return mock.response;
    }

    /**
     * Enhanced condition matching with multiple strategies
     */
    private async matchesCondition(mock: MockDefinition, args: any[]): Promise<boolean> {
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

        // 4. Custom matcher function
        if (mock.when.matcher) {
            try {
                const matcherFn = new Function('args', 'input', 'context', mock.when.matcher);
                if (!matcherFn(args, input, context)) {
                    return false;
                }
            } catch (error) {
                this.logger.error(`Matcher function error: ${error}`);
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
    private extractInputFromArgs(args: any[]): Record<string, any> {
        const input: Record<string, any> = {};

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
    private buildRequestContext(args: any[]): Record<string, any> {
        return {
            timestamp: new Date().toISOString(),
            argsCount: args.length,
            hasObjectArgs: args.some(arg => typeof arg === 'object'),
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
    private matchesContext(context: Record<string, any>, expectedContext: Record<string, any>): boolean {
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
    private matchesPartialArgs(args: any[], partialArgs: any[]): boolean {
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
    private recordMockExecution(serviceMethod: string, args: any[], mock: MockDefinition, executionTime: number): void {
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
} 