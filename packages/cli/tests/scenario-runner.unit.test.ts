import { describe, expect, it, mock } from 'bun:test';
import { ScenarioRunner } from '../src/scenario-runner/index.js';
import { ScenarioVerifier } from '../src/scenario-runner/verification.js';
import { MetricsCollector, BenchmarkAnalyzer } from '../src/scenario-runner/metrics.js';
import type { Scenario } from '../src/scenario-runner/types.js';
import type { UUID } from '@elizaos/core';

// Note: Module mocking in bun:test is handled differently
// We'll create mock objects directly in the test

describe('ScenarioRunner Unit Tests', () => {
  const mockServer = {
    agents: new Map([
      [
        'test-agent',
        {
          agentId: 'test-agent',
          character: { name: 'Test Agent' },
          ensureWorldExists: mock(),
          ensureRoomExists: mock(),
          createMemory: mock(),
          emitEvent: mock(),
        },
      ],
    ]),
  } as any;

  const mockRuntime = {
    agentId: 'test-agent',
    character: { name: 'Test Agent' },
    ensureWorldExists: mock(),
    ensureRoomExists: mock(),
    createMemory: mock(),
    emitEvent: mock(),
    useModel: mock(() => Promise.resolve('YES - Test passed')),
  } as any;

  it('should create a ScenarioRunner instance', () => {
    const runner = new ScenarioRunner(mockServer, mockRuntime);
    expect(runner).toBeInstanceOf(ScenarioRunner);
  });

  it('should validate scenario correctly', async () => {
    const runner = new ScenarioRunner(mockServer, mockRuntime);

    const validScenario: Scenario = {
      id: 'test-scenario',
      name: 'Test Scenario',
      description: 'A test scenario',
      actors: [
        {
          id: 'subject' as UUID,
          name: 'Test Agent',
          role: 'subject',
          script: { steps: [] }
        },
      ],
      setup: {},
      execution: {},
      verification: {
        rules: [
          {
            id: 'test-rule',
            type: 'llm',
            description: 'Test rule',
            weight: 1,
            config: {},
          },
        ],
      },
    };

    // This should not throw
    expect(() => (runner as any).validateScenario(validScenario)).not.toThrow();
  });

  it('should reject invalid scenarios', () => {
    const runner = new ScenarioRunner(mockServer, mockRuntime);

    const invalidScenario: Scenario = {
      id: '',
      name: '',
      description: '',
      actors: [],
      setup: {},
      execution: {},
      verification: {
        rules: [],
      },
    };

    expect(() => (runner as any).validateScenario(invalidScenario)).toThrow();
  });

  it('should require exactly one subject actor', () => {
    const runner = new ScenarioRunner(mockServer, mockRuntime);

    const noSubjectScenario: Scenario = {
      id: 'test',
      name: 'Test',
      description: 'Test',
      actors: [
        {
          id: 'tester' as UUID,
          name: 'Tester',
          role: 'subject',
          script: { steps: [] }
        },
      ],
      setup: {},
      execution: {},
      verification: {
        rules: [
          {
            id: 'test-rule',
            type: 'llm',
            description: 'Test rule',
            weight: 1,
            config: {},
          },
        ],
      },
    };

    expect(() => (runner as any).validateScenario(noSubjectScenario)).toThrow(
      'exactly one subject actor'
    );

    const multipleSubjectsScenario: Scenario = {
      ...noSubjectScenario,
      actors: [
        {
          id: 'subject1' as UUID,
          name: 'Subject 1',
          role: 'subject',
          script: { steps: [] }
        },
        {
          id: 'subject2' as UUID,
          name: 'Subject 2',
          role: 'subject',
          script: { steps: [] }
        },
      ],
    };

    expect(() => (runner as any).validateScenario(multipleSubjectsScenario)).toThrow(
      'can only have one subject actor'
    );
  });
});

describe('ScenarioVerifier Unit Tests', () => {
  const mockRuntime = {
    useModel: mock(),
  } as any;

  it('should create a ScenarioVerifier instance', () => {
    const verifier = new ScenarioVerifier(mockRuntime);
    expect(verifier).toBeInstanceOf(ScenarioVerifier);
  });
});

describe('MetricsCollector Unit Tests', () => {
  it('should create a MetricsCollector instance', () => {
    const collector = new MetricsCollector();
    expect(collector).toBeInstanceOf(MetricsCollector);
  });

  it('should start and collect metrics', () => {
    const collector = new MetricsCollector();

    // Mock Date.now to simulate time passing
    const originalDateNow = Date.now;
    let currentTime = 1000000;
    Date.now = mock(() => currentTime);

    collector.start();

    // Simulate 5 seconds passing
    currentTime += 5000;

    const mockContext = {
      scenario: {
        actors: [
          {
            id: 'actor1',
            name: 'Actor 1',
            role: 'subject' as const,
            script: {
              steps: [
                { type: 'message' as const, content: 'Hello' },
                { type: 'wait' as const, waitTime: 1000 },
              ],
            },
          },
        ],
        benchmarks: {
          customMetrics: [],
        },
      },
      transcript: [
        {
          id: 'msg1',
          timestamp: currentTime - 2000,
          actorId: 'actor1',
          actorName: 'Actor 1',
          content: { text: 'Hello' },
          messageType: 'incoming' as const,
        },
      ],
      startTime: currentTime - 5000,
      metrics: {},
    } as any;

    const metrics = collector.collect(mockContext);

    // Restore original Date.now
    Date.now = originalDateNow;

    expect(metrics).toBeDefined();
    expect(metrics.messageCount).toBe(1);
    expect(metrics.duration).toBe(5000);
  });
});

describe('BenchmarkAnalyzer Unit Tests', () => {
  it('should create a BenchmarkAnalyzer instance', () => {
    const analyzer = new BenchmarkAnalyzer();
    expect(analyzer).toBeInstanceOf(BenchmarkAnalyzer);
  });
});
