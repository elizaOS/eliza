import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ScenarioRunner } from '../src/scenario-runner/index.js';
import { type Scenario } from '../src/scenario-runner/types.js';
import { AgentServer } from '@elizaos/server';
import { type IAgentRuntime, type Character, UUID } from '@elizaos/core';
import { truthVsLieScenario } from '../scenarios/truth-vs-lie.js';

// Mock logger to avoid noise in tests
vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual('@elizaos/core');
  return {
    ...actual,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
  };
});

// Mock AgentServer to avoid database initialization
vi.mock('@elizaos/server', () => ({
  AgentServer: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    agents: new Map(),
  })),
}));

describe('ScenarioRunner Integration Tests', () => {
  let server: AgentServer;
  let mockRuntime: IAgentRuntime;
  let scenarioRunner: ScenarioRunner;

  const mockCharacter: Character = {
    id: 'test-agent' as UUID,
    name: 'Test Agent',
    username: 'testagent',
    system: 'You are a helpful test agent.',
    settings: {
      secrets: {},
    },
    plugins: [],
    bio: [],
    messageExamples: [],
    postExamples: [],
    topics: [],
    adjectives: [],
    knowledge: [],
    style: {
      all: [],
      chat: [],
      post: [],
    },
  };

  beforeEach(async () => {
    // Create mock runtime with all necessary methods
    mockRuntime = {
      agentId: 'test-agent-id' as any,
      character: mockCharacter,
      databaseAdapter: {
        db: ':memory:',
      } as any,
      token: 'test-token',
      actions: [],
      providers: [],

      // Mock core methods
      initialize: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),

      // Mock database methods
      ensureWorldExists: vi.fn().mockResolvedValue(undefined),
      ensureRoomExists: vi.fn().mockResolvedValue(undefined),
      createMemory: vi.fn().mockResolvedValue(undefined),

      // Mock event system
      emitEvent: vi.fn().mockImplementation(async (event, data) => {
        // Simulate agent processing and response
        if (event === 'messageReceived' && data.callback) {
          await data.callback?.({
            text: 'Test response from agent',
            source: 'test-agent',
            actions: ['HELLO_WORLD'],
          });
        }
      }),

      // Mock service methods
      getService: vi.fn().mockReturnValue(null),
      registerService: vi.fn(),

      // Mock model methods
      useModel: vi.fn().mockResolvedValue('Mocked LLM response'),

      // Add other required methods as stubs
      getCachedEmbeddings: vi.fn().mockResolvedValue([]),
      addKnowledge: vi.fn().mockResolvedValue(undefined),
      processActions: vi.fn().mockResolvedValue([]),
      evaluate: vi.fn().mockResolvedValue([]),
    } as any;

    // Create server with mock runtime
    server = new AgentServer();
    await server.initialize({ dataDir: "./test-data" });

    // Add the mock runtime to the server
    // server.agents.set('test-agent-id', mockRuntime); // agents property doesn't exist

    // Create scenario runner
    scenarioRunner = new ScenarioRunner(server, mockRuntime);
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    vi.clearAllMocks();
  });

  it('should successfully run a complete scenario', async () => {
    // Create a simple test scenario
    const testScenario: Scenario = {
      id: 'test-scenario-basic',
      name: 'Basic Test Scenario',
      description: 'A simple scenario to test the runner',
      actors: [
        {
          id: 'subject' as UUID,
          name: 'Test Agent',
          role: 'subject',
          script: { steps: [] }
        },
        {
          id: 'tester' as UUID,
          name: 'Test User',
          role: 'assistant',
          script: {
            steps: [
              {
                type: 'message',
                content: 'Hello, can you help me?',
              },
              {
                type: 'wait',
                waitTime: 1000,
              },
            ],
          },
        },
      ],
      setup: {
        roomName: 'Test Room',
        roomType: 'group',
      },
      execution: {
        maxDuration: 30000, // 30 seconds
        maxSteps: 10,
      },
      verification: {
        rules: [
          {
            id: 'response-check',
            type: 'llm',
            description: 'Check if agent responded appropriately',
            weight: 1,
            config: {
              llmPrompt: 'Did the agent respond to the greeting? Answer with YES or NO.',
            },
          },
          {
            id: 'message-count',
            type: 'llm',
            description: 'Check message count',
            weight: 1,
            config: {
              rule: 'messageCount',
              operator: 'gte',
              value: 1,
            },
          },
        ],
      },
    };

    // Mock LLM verification response
    (mockRuntime.useModel as any).mockResolvedValue(
      'YES - The agent responded appropriately to the greeting.'
    );

    // Run the scenario
    const result = await scenarioRunner.runScenario(testScenario);

    // Verify the result
    expect(result).toBeDefined();
    expect(result.scenarioId).toBe('test-scenario-basic');
    expect(result.name).toBe('Basic Test Scenario');
    expect(result.duration).toBeGreaterThan(0);
    expect(result.transcript).toBeDefined();
    expect(Array.isArray(result.transcript)).toBe(true);

    // Verify runtime methods were called
    expect(mockRuntime.ensureWorldExists).toHaveBeenCalled();
    expect(mockRuntime.ensureRoomExists).toHaveBeenCalled();
    expect(mockRuntime.createMemory).toHaveBeenCalled();
    expect(mockRuntime.emitEvent).toHaveBeenCalled();

    // Verify verification was attempted
    expect(result.verificationResults).toBeDefined();
    expect(Array.isArray(result.verificationResults)).toBe(true);
  }, 45000); // 45 second timeout

  it('should handle scenario validation errors', async () => {
    const invalidScenario: Scenario = {
      id: '',
      name: 'Invalid Scenario',
      description: 'Missing required fields',
      actors: [], // No actors
      setup: {},
      execution: {},
      verification: {
        rules: [], // No verification rules
      },
    };

    await expect(scenarioRunner.runScenario(invalidScenario)).rejects.toThrow();
  });

  it('should run the truth vs lie scenario example', async () => {
    // Mock LLM responses for verification
    (mockRuntime.useModel as any)
      .mockResolvedValueOnce('YES - The detective successfully identified the deceptive witness.')
      .mockResolvedValueOnce(
        'YES - The detective demonstrated appropriate questioning techniques.'
      );

    // Run the pre-built scenario
    const result = await scenarioRunner.runScenario(truthVsLieScenario);

    // Verify the scenario completed
    expect(result).toBeDefined();
    expect(result.scenarioId).toBe('truth-vs-lie');
    expect(result.duration).toBeGreaterThan(0);
    expect(result.transcript).toBeDefined();

    // Verify that messages were exchanged
    expect(result.transcript.length).toBeGreaterThan(0); // Messages were exchanged

    // Verify verification rules were processed
    expect(result.verificationResults).toBeDefined();
    expect(result.verificationResults.length).toBeGreaterThan(0);
  }, 60000); // 60 second timeout for complex scenario

  it('should handle multiple scenarios in sequence', async () => {
    const scenario1: Scenario = {
      id: 'seq-test-1',
      name: 'Sequential Test 1',
      description: 'First test scenario',
      actors: [
        {
          id: 'subject' as UUID, name: 'Agent', role: 'subject',
          script: { steps: [] }
        },
        {
          id: 'user1' as UUID,
          name: 'User 1',
          role: 'assistant',
          script: {
            steps: [{ type: 'message', content: 'Hello from scenario 1' }],
          },
        },
      ],
      setup: {},
      execution: { maxDuration: 10000 },
      verification: {
        rules: [
          {
            id: 'basic-check-1',
            type: 'llm',
            description: 'Basic check',
            weight: 1,
            config: { rule: 'messageCount', operator: 'gte', value: 1 },
          },
        ],
      },
    };

    const scenario2: Scenario = {
      ...scenario1,
      id: 'seq-test-2',
      name: 'Sequential Test 2',
      description: 'Second test scenario',
      actors: [
        {
          id: 'subject' as UUID, name: 'Agent', role: 'subject',
          script: { steps: [] }
        },
        {
          id: 'user2' as UUID,
          name: 'User 2',
          role: 'assistant',
          script: {
            steps: [{ type: 'message', content: 'Hello from scenario 2' }],
          },
        },
      ],
      verification: {
        rules: [
          {
            id: 'basic-check-2',
            type: 'llm',
            description: 'Basic check 2',
            weight: 1,
            config: { rule: 'messageCount', operator: 'gte', value: 1 },
          },
        ],
      },
    };

    const results = await scenarioRunner.runScenarios([scenario1, scenario2]);

    expect(results).toHaveLength(2);
    expect(results[0].scenarioId).toBe('seq-test-1');
    expect(results[1].scenarioId).toBe('seq-test-2');
    expect(results[0].duration).toBeGreaterThan(0);
    expect(results[1].duration).toBeGreaterThan(0);
  }, 45000);

  it('should collect metrics during scenario execution', async () => {
    const metricsScenario: Scenario = {
      id: 'metrics-test',
      name: 'Metrics Test Scenario',
      description: 'Test metrics collection',
      actors: [
        {
          id: 'subject' as UUID, name: 'Agent', role: 'subject',
          script: { steps: [] }
        },
        {
          id: 'user' as UUID,
          name: 'User',
          role: 'assistant',
          script: {
            steps: [
              { type: 'message', content: 'First message' },
              { type: 'wait', waitTime: 500 },
              { type: 'message', content: 'Second message' },
            ],
          },
        },
      ],
      setup: {},
      execution: { maxDuration: 15000 },
      verification: {
        rules: [
          {
            id: 'metrics-check',
            type: 'llm',
            description: 'Check metrics collection',
            weight: 1,
            config: { rule: 'messageCount', operator: 'gte', value: 2 },
          },
        ],
      },
    };

    const result = await scenarioRunner.runScenario(metricsScenario);

    // Verify metrics were collected
    expect(result.metrics).toBeDefined();
    expect(result.duration).toBeDefined();
    expect(result.duration).toBeGreaterThan(0);
    expect(result.transcript).toBeDefined();
    expect(result.transcript.length).toBeGreaterThan(0);
  }, 30000);
});
