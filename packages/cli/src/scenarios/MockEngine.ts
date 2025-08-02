import { AgentRuntime } from '@elizaos/core';
import { Scenario } from './schema';
import _ from 'lodash';

type MockDefinition = NonNullable<NonNullable<Scenario['setup']>['mocks']>[0];

export class MockEngine {
    private originalGetService: AgentRuntime['getService'];
    private mockRegistry: Map<string, MockDefinition[]> = new Map();

    constructor(private runtime: AgentRuntime) {
        this.originalGetService = this.runtime.getService.bind(this.runtime);
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
                    return (...args: any[]) => {
                        const potentialMocks = this.mockRegistry.get(key)!;
                        console.log(`[MOCK] Checking mocks for ${key} with args:`, args);
                        console.log(`[MOCK] Available mocks:`, potentialMocks.map(m => ({
                            hasWhen: !!m.when,
                            whenArgs: m.when?.args,
                            hasResponse: !!m.response
                        })));

                        // Find a conditional mock that matches the arguments
                        const conditionalMock = potentialMocks.find(m =>
                            m.when && _.isEqual(args, m.when.args)
                        );

                        if (conditionalMock) {
                            console.log(`[MOCK] Applied conditional mock for ${key} with args:`, args);
                            return Promise.resolve(conditionalMock.response);
                        }

                        // Find a generic (non-conditional) mock
                        const genericMock = potentialMocks.find(m => !m.when);
                        if (genericMock) {
                            console.log(`[MOCK] Applied generic mock for ${key}`);
                            return Promise.resolve(genericMock.response);
                        }

                        // No matching mock found, call the original method
                        console.log(`[MOCK] No mock found for ${key}, calling original method`);
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
        console.log('[MOCK] All mocks reverted');
    }

    public getMockRegistry() {
        return this.mockRegistry;
    }
} 