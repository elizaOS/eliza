import { type IAgentRuntime, type UUID } from '@elizaos/core';
import { AgentServer } from '@elizaos/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScenarioRunner } from '../../../src/scenario-runner/index.js';
import type { Scenario } from '../../../src/scenario-runner/types.js';
import { AgentManager } from '../../../src/scenario-runner/agent-manager.js';
import type { ScenarioActor } from '../../../src/scenario-runner/types.js';
import { v4 as uuidv4 } from 'uuid';

// Mock dependencies
vi.mock('@elizaos/server');
vi.mock('@elizaos/core');
vi.mock('../../../src/scenario-runner/agent-manager.js');
vi.mock('../../../src/scenario-runner/verification.js');
vi.mock('../../../src/scenario-runner/metrics.js');
vi.mock('../../../src/scenario-runner/integration-test.js');
vi.mock('../../../src/scenario-runner/llm-scenario-generator.js');

describe('ScenarioRunner', () => {
  let server: AgentServer;
  let runtime: IAgentRuntime;
  let runner: ScenarioRunner;
  let mockScenario: Scenario;

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up mocks
    const agents = new Map<string, IAgentRuntime>();

    server = {
      agents,
      database: {},
      initialize: vi.fn(),
      registerAgent: vi.fn(),
      unregisterAgent: vi.fn(),
      stop: vi.fn(),
    } as any;

    runtime = {
      agentId: uuidv4() as UUID,
      character: {
        name: 'TestAgent',
        bio: ['Test bio'],
        system: 'Test system prompt',
      },
      actions: [],
      providers: [],
      evaluators: [],
      services: new Map(),
      getSetting: vi.fn(),
      composeState: vi.fn().mockResolvedValue({
        values: {},
        data: {},
        text: '',
      }),
      processMessage: vi.fn(),
      evaluate: vi.fn(),
      processActions: vi.fn(),
      useModel: vi.fn().mockResolvedValue('Mock response'),
      createMemory: vi.fn(),
      getMemories: vi.fn().mockResolvedValue([]),
      updateMemory: vi.fn(),
      deleteMemory: vi.fn(),
      searchMemories: vi.fn().mockResolvedValue([]),
    } as unknown as IAgentRuntime;

    // Add runtime to server agents
    agents.set(runtime.agentId, runtime);

    runner = new ScenarioRunner(server, runtime);

    // Create a basic test scenario
    mockScenario = {
      id: uuidv4(),
      name: 'Test Scenario',
      description: 'A test scenario for unit testing',
      actors: [
        {
          id: uuidv4() as UUID,
          name: 'Test Subject',
          role: 'subject',
          script: {
            steps: [{ type: 'message', content: 'Hello, world!' }],
          },
        },
      ],
      setup: {
        roomType: 'group',
      },
      execution: {
        maxDuration: 10000,
        maxSteps: 10,
      },
      verification: {
        rules: [
          {
            id: 'test-rule',
            type: 'llm',
            description: 'Test verification rule',
            config: {},
          },
        ],
      },
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create a ScenarioRunner instance', () => {
      expect(runner).toBeDefined();
      expect(runner).toBeInstanceOf(ScenarioRunner);
    });

    it('should initialize with correct dependencies', () => {
      expect(AgentManager).toHaveBeenCalled();
    });
  });

  describe('runScenario', () => {
    it('should successfully run a basic scenario', async () => {
      const result = await runner.runScenario(mockScenario);

      expect(result).toBeDefined();
      expect(result.scenarioId).toBe(mockScenario.id);
      expect(result.name).toBe(mockScenario.name);
      expect(result.passed).toBeDefined();
      expect(result.metrics).toBeDefined();
      expect(result.verificationResults).toBeInstanceOf(Array);
    });

    it('should validate scenario before execution', async () => {
      const invalidScenario = { ...mockScenario, actors: [] };

      await expect(runner.runScenario(invalidScenario)).rejects.toThrow(
        'Scenario must have at least one actor'
      );
    });

    it('should handle setup errors gracefully', async () => {
      (runtime.ensureWorldExists as any).mockRejectedValueOnce(new Error('Setup failed'));

      const result = await runner.runScenario(mockScenario);

      expect(result.passed).toBe(false);
      expect(result.errors).toContain('Setup failed');
    });

    it('should track metrics during execution', async () => {
      const result = await runner.runScenario(mockScenario);

      expect(result.metrics.messageCount).toBeGreaterThanOrEqual(0);
      expect(result.metrics.duration).toBeGreaterThan(0);
      expect(result.metrics.tokenUsage).toBeDefined();
    });

    it('should execute verification rules', async () => {
      const result = await runner.runScenario(mockScenario, { verbose: true });

      expect(result.verificationResults).toHaveLength(1);
      expect(result.verificationResults[0].ruleId).toBe('test-rule');
    });

    it('should support progress callbacks', async () => {
      const progressCallback = vi.fn();

      await runner.runScenario(mockScenario, {}, progressCallback);

      expect(progressCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          scenarioId: mockScenario.id,
          phase: expect.any(String),
        })
      );
    });

    it('should run a simple scenario', async () => {
      const testScenario: Scenario = {
        id: uuidv4(),
        name: 'Simple Test',
        description: 'A simple test scenario',
        actors: [
          {
            id: uuidv4() as UUID,
            name: 'TestActor',
            role: 'subject',
            personality: {
              traits: ['test'],
              systemPrompt: 'Test prompt',
              interests: [],
            },
            script: {
              steps: [
                {
                  type: 'message',
                  content: 'Test message',
                },
              ],
            },
          },
        ],
        setup: {},
        execution: {},
        verification: {
          rules: [],
        },
      };

      // Since agentManager was removed, we'll mock the runtime directly
      // The scenario runner now uses the agents map instead

      const result = await runner.runScenario(testScenario);

      expect(result).toBeDefined();
      expect(result.scenarioId).toBe(testScenario.id);
      expect(result.passed).toBeDefined();
    });

    it('should handle scenario with multiple actors', async () => {
      const testScenario: Scenario = {
        id: uuidv4(),
        name: 'Multi-Actor Test',
        description: 'A multi-actor test scenario',
        actors: [
          {
            id: uuidv4() as UUID,
            name: 'Alice',
            role: 'subject',
            personality: {
              traits: ['friendly'],
              systemPrompt: 'You are Alice',
              interests: ['conversation'],
            },
            script: {
              steps: [
                {
                  type: 'message',
                  content: 'Hello Bob!',
                },
              ],
            },
          },
          {
            id: uuidv4() as UUID,
            name: 'Bob',
            role: 'assistant',
            personality: {
              traits: ['helpful'],
              systemPrompt: 'You are Bob',
              interests: ['helping'],
            },
          },
        ],
        setup: {},
        execution: {},
        verification: {
          rules: [],
        },
      };

      // Since agentManager was removed, we'll mock the runtime directly
      // The scenario runner now uses the agents map instead

      const result = await runner.runScenario(testScenario);

      expect(result).toBeDefined();
      expect(result.passed).toBeDefined();
      expect(result.transcript.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('error handling', () => {
    it('should handle runtime errors during scenario execution', async () => {
      const testScenario: Scenario = {
        id: uuidv4(),
        name: 'Error Test',
        description: 'A scenario that will error',
        actors: [
          {
            id: uuidv4() as UUID,
            name: 'ErrorActor',
            role: 'subject',
            personality: {
              traits: ['error-prone'],
              systemPrompt: 'You will cause errors',
              interests: [],
            },
            script: {
              steps: [
                {
                  type: 'action',
                  action: 'non_existent_action',
                },
              ],
            },
          },
        ],
        setup: {},
        execution: {},
        verification: {
          rules: [],
        },
      };

      // Since agentManager was removed, we'll mock the runtime to throw an error
      (runtime.ensureWorldExists as any).mockRejectedValueOnce(new Error('Test error'));

      const result = await runner.runScenario(testScenario);

      expect(result.passed).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.length).toBeGreaterThan(0);
    });
  });

  describe('Agent setup', () => {
    it('should setup actors with the agents map', async () => {
      const actor: ScenarioActor = {
        id: uuidv4() as UUID,
        name: 'TestActor',
        role: 'subject',
        personality: {
          traits: ['test'],
          systemPrompt: 'Test',
          interests: [],
        },
      };

      const scenario: Scenario = {
        id: uuidv4(),
        name: 'Test',
        description: 'Test',
        actors: [actor],
        setup: {},
        execution: {},
        verification: {
          rules: [],
        },
      };

      // Add the actor's runtime to the agents map
      runner.agents.set(actor.name, runtime);

      const context = await runner['setupScenario'](scenario);

      // Verify the actor was set up with the correct runtime
      expect(context.actors.get(actor.id)?.runtime).toBe(runtime);
    });
  });

  describe('runScenarios', () => {
    it('should run multiple scenarios sequentially', async () => {
      const scenarios = [mockScenario, { ...mockScenario, id: 'test-2' }];

      const results = await runner.runScenarios(scenarios);

      expect(results).toHaveLength(2);
      expect(results[0].scenarioId).toBe('test-scenario');
      expect(results[1].scenarioId).toBe('test-2');
    });

    it('should run scenarios in parallel when specified', async () => {
      const scenarios = Array.from({ length: 5 }, (_, i) => ({
        ...mockScenario,
        id: `test-${i}`,
      }));

      const startTime = Date.now();
      const results = await runner.runScenarios(scenarios, {
        parallel: true,
        maxConcurrency: 3,
      });
      const duration = Date.now() - startTime;

      expect(results).toHaveLength(5);
      // Parallel execution should be faster than sequential
      expect(duration).toBeLessThan(5000);
    });

    it('should respect maxConcurrency limit', async () => {
      let currentConcurrent = 0;
      let maxConcurrent = 0;

      // Mock to track concurrent executions
      (runtime.ensureWorldExists as any).mockImplementation(async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((resolve) => setTimeout(resolve, 100));
        currentConcurrent--;
      });

      const scenarios = Array.from({ length: 6 }, (_, i) => ({
        ...mockScenario,
        id: `test-${i}`,
      }));

      await runner.runScenarios(scenarios, {
        parallel: true,
        maxConcurrency: 2,
      });

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });

  describe('validateScenario', () => {
    it('should validate required fields', () => {
      const invalidScenarios = [
        { ...mockScenario, id: undefined },
        { ...mockScenario, name: undefined },
        { ...mockScenario, actors: [] },
        { ...mockScenario, verification: { rules: [] } },
      ];

      for (const scenario of invalidScenarios) {
        expect(() => runner['validateScenario'](scenario as any)).toThrow();
      }
    });

    it('should require exactly one subject actor', () => {
      const noSubject = {
        ...mockScenario,
        actors: [
          {
            id: 'test-id' as UUID,
            name: 'Test',
            role: 'subject' as const,
            script: { steps: [] },
          },
        ],
      };

      expect(() => runner['validateScenario'](noSubject)).toThrow(
        'Scenario must have exactly one subject actor'
      );

      const twoSubjects = {
        ...mockScenario,
        actors: [
          {
            id: 'sub1-id' as UUID,
            name: 'Subject 1',
            role: 'subject' as const,
            script: { steps: [] },
          },
          {
            id: 'sub2-id' as UUID,
            name: 'Subject 2',
            role: 'subject' as const,
            script: { steps: [] },
          },
        ],
      };

      expect(() => runner['validateScenario'](twoSubjects)).toThrow(
        'Scenario can only have one subject actor'
      );
    });
  });

  describe('setupScenario', () => {
    it('should create world and room for scenario', async () => {
      const context = await runner['setupScenario'](mockScenario);

      expect(runtime.ensureWorldExists).toHaveBeenCalled();
      expect(runtime.ensureRoomExists).toHaveBeenCalled();
      expect(context.roomId).toBeDefined();
      expect(context.worldId).toBeDefined();
      expect(context.actors.size).toBe(1);
    });

    it('should handle initial messages in setup', async () => {
      const scenarioWithMessages = {
        ...mockScenario,
        setup: {
          ...mockScenario.setup,
          initialMessages: [
            { id: '1', content: 'Initial message', sender: 'system', timestamp: Date.now() },
          ],
        },
      };

      await runner['setupScenario'](scenarioWithMessages);

      expect(runtime.createMemory).toHaveBeenCalled();
    });
  });

  describe('executeScenario', () => {
    it('should execute actor scripts', async () => {
      const context = await runner['setupScenario'](mockScenario);
      const progressCallback = vi.fn();

      await runner['executeScenario'](context, progressCallback);

      // Verify script execution
      expect(context.transcript.length).toBeGreaterThan(0);
    });

    it('should handle different script step types', async () => {
      const complexScenario: Scenario = {
        ...mockScenario,
        actors: [
          {
            id: 'subject-id' as UUID,
            name: 'Test Subject',
            role: 'subject',
            script: {
              steps: [
                { type: 'message', content: 'Test message' },
                { type: 'wait', waitTime: 100 },
                { type: 'action', actionName: 'TEST_ACTION', actionParams: {} },
                {
                  type: 'assert',
                  assertion: { type: 'contains', value: 'test', description: 'Test assertion' },
                },
              ],
            },
          },
        ],
      };

      const context = await runner['setupScenario'](complexScenario);
      await runner['executeScenario'](context);

      // All steps should have been executed
      expect(context.transcript).toBeDefined();
    });
  });

  describe('teardownScenario', () => {
    it('should clean up resources after scenario', async () => {
      const context = await runner['setupScenario'](mockScenario);

      await runner['teardownScenario'](context);

      // Verify cleanup happened
      expect(runner['activeScenarios'].has(mockScenario.id)).toBe(false);
    });
  });

  describe('determinePass', () => {
    it('should determine pass based on verification weight', () => {
      const verificationResults = [
        { ruleId: 'rule1', passed: true, ruleName: 'Rule 1', reason: 'Passed' },
        { ruleId: 'rule2', passed: false, ruleName: 'Rule 2', reason: 'Failed' },
        { ruleId: 'rule3', passed: true, ruleName: 'Rule 3', reason: 'Passed' },
      ];

      const scenario = {
        ...mockScenario,
        verification: {
          rules: [
            { id: 'rule1', type: 'llm' as const, description: 'Rule 1', weight: 1, config: {} },
            { id: 'rule2', type: 'llm' as const, description: 'Rule 2', weight: 2, config: {} },
            { id: 'rule3', type: 'llm' as const, description: 'Rule 3', weight: 1, config: {} },
          ],
        },
      };

      const passed = runner['determinePass'](verificationResults, scenario);

      // 2/4 weight passed (50%), below 70% threshold
      expect(passed).toBe(false);
    });
  });

  describe('calculateOverallScore', () => {
    it('should calculate average score from verification results', () => {
      const verificationResults = [
        { ruleId: 'rule1', passed: true, score: 0.9, ruleName: 'Rule 1', reason: 'Good' },
        { ruleId: 'rule2', passed: false, score: 0.3, ruleName: 'Rule 2', reason: 'Poor' },
        { ruleId: 'rule3', passed: true, score: 0.8, ruleName: 'Rule 3', reason: 'Good' },
      ];

      const score = runner['calculateOverallScore'](verificationResults);

      expect(score).toBeCloseTo(0.67, 2); // (0.9 + 0.3 + 0.8) / 3
    });

    it('should handle missing scores', () => {
      const verificationResults = [
        { ruleId: 'rule1', passed: true, ruleName: 'Rule 1', reason: 'Passed' },
        { ruleId: 'rule2', passed: false, ruleName: 'Rule 2', reason: 'Failed' },
      ];

      const score = runner['calculateOverallScore'](verificationResults);

      expect(score).toBe(0.5); // (1 + 0) / 2
    });
  });
});
