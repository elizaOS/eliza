import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { AgentRuntime } from '../runtime';
import {
  type Action,
  type ActionResult,
  type Memory,
  type State,
  type UUID,
  type ActionPlan,
  type PlanExecutionResult,
  type PlanningContext,
  type ActionContext,
  ModelType,
} from '../types';
import { planningScenarios } from './planning-scenarios';
import { PlanExecutionContext, parsePlan, validatePlan, getExecutionOrder } from '../planning';
import { createLogger } from '../logger';

// Mock actions for testing
const mockActions: Map<string, Action> = new Map([
  [
    'MUTE_ROOM',
    {
      name: 'MUTE_ROOM',
      description: 'Mute a room',
      validate: async () => true,
      handler: async (runtime, message, state, options) => {
        const shouldSucceed = options?.forceSuccess !== false;
        return {
          data: {
            actionName: 'MUTE_ROOM',
            roomId: message.roomId,
            muted: shouldSucceed,
          },
          values: {
            roomMuteState: shouldSucceed ? 'MUTED' : 'NOT_MUTED',
            muteSuccess: shouldSucceed,
          },
          text: shouldSucceed ? 'Room muted' : 'Failed to mute room',
        };
      },
      similes: [],
    },
  ],
  [
    'FOLLOW_ROOM',
    {
      name: 'FOLLOW_ROOM',
      description: 'Follow a room',
      validate: async () => true,
      handler: async (runtime, message, state, options) => {
        const shouldSucceed = options?.forceSuccess !== false;
        return {
          data: {
            actionName: 'FOLLOW_ROOM',
            roomId: message.roomId,
            followed: shouldSucceed,
          },
          values: {
            roomFollowState: shouldSucceed ? 'FOLLOWED' : 'NOT_FOLLOWED',
            followSuccess: shouldSucceed,
          },
          text: shouldSucceed ? 'Room followed' : 'Failed to follow room',
        };
      },
      similes: [],
    },
  ],
  [
    'REPLY',
    {
      name: 'REPLY',
      description: 'Reply to a message',
      validate: async () => true,
      handler: async (runtime, message, state, options) => {
        const context = options?.context as ActionContext | undefined;
        const previousResults = context?.previousResults || [];
        const lastResult = previousResults[previousResults.length - 1];

        let replyText = 'Done';
        if (lastResult?.text) {
          replyText = `Confirmed: ${lastResult.text}`;
        }

        return {
          data: {
            actionName: 'REPLY',
            response: replyText,
          },
          values: {
            lastReply: replyText,
            lastReplyTime: Date.now(),
          },
          text: replyText,
        };
      },
      similes: [],
    },
  ],
  [
    'UPDATE_SETTINGS',
    {
      name: 'UPDATE_SETTINGS',
      description: 'Update settings',
      validate: async () => true,
      handler: async (runtime, message, state, options) => {
        const settingKey = options?.settingKey || 'UNKNOWN';
        const settingValue = options?.settingValue || 'default';

        return {
          data: {
            actionName: 'UPDATE_SETTINGS',
            updated: { [settingKey as string]: settingValue },
          },
          values: {
            [settingKey as string]: settingValue,
            lastSettingsUpdate: Date.now(),
          },
          text: `Updated ${settingKey} to ${settingValue}`,
        };
      },
      similes: [],
    },
  ],
]);

// Create mock runtime for testing
function createMockRuntime(actions: Action[] = []): AgentRuntime {
  const runtime = new AgentRuntime({
    agentId: uuidv4() as UUID,
    character: {
      name: 'TestAgent',
      bio: ['Test agent for planning'],
      settings: {
        enablePlanning: true,
      },
    },
    settings: {},
  });

  // Register mock actions
  actions.forEach((action) => runtime.registerAction(action));

  // Mock the useModel method for plan generation
  (runtime as any).useModel = async (modelType: any, params: any) => {
    if (modelType === ModelType.TEXT_REASONING_LARGE || modelType === ModelType.TEXT_LARGE) {
      const step1Id = uuidv4() as UUID;
      const step2Id = uuidv4() as UUID;

      // Extract goal from prompt if available
      let goal = 'Test goal';
      if (params?.prompt) {
        const goalMatch = params.prompt.match(/# Goal\s*\n(.*?)(?:\n|$)/);
        if (goalMatch) {
          goal = goalMatch[1].trim();
        }
      }

      return `<plan>
<goal>${goal}</goal>
<steps>
<step>
<id>${step1Id}</id>
<action>MUTE_ROOM</action>
<parameters>{}</parameters>
<dependencies></dependencies>
<expectedOutcome>Action completed</expectedOutcome>
</step>
<step>
<id>${step2Id}</id>
<action>REPLY</action>
<parameters>{}</parameters>
<dependencies>${step1Id}</dependencies>
<expectedOutcome>User informed</expectedOutcome>
</step>
</steps>
<executionModel>sequential</executionModel>
<estimatedDuration>200</estimatedDuration>
</plan>`;
    }
    return '';
  };

  return runtime;
}

describe('Planning System', () => {
  let runtime: AgentRuntime;
  const logger = createLogger({ agentName: 'TestAgent', logLevel: 'error' });

  beforeEach(() => {
    runtime = createMockRuntime(Array.from(mockActions.values()));
  });

  describe('Plan Generation', () => {
    it('should generate a valid plan for a simple goal', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: {
          text: 'Please mute this channel and let me know when done',
        },
        createdAt: Date.now(),
      };

      const context: PlanningContext = {
        goal: 'Mute the current room and inform the user',
        constraints: [],
        availableActions: ['MUTE_ROOM', 'REPLY'],
        availableProviders: [],
      };

      const plan = await (runtime as any).generatePlan(message, context);

      expect(plan).toBeDefined();
      expect(plan.goal).toBe(context.goal);
      expect(plan.steps).toHaveLength(2);
      expect(plan.steps[0].actionName).toBe('MUTE_ROOM');
      expect(plan.steps[1].actionName).toBe('REPLY');
    });

    it('should validate plan feasibility', async () => {
      const plan: ActionPlan = {
        id: uuidv4() as UUID,
        goal: 'Test plan',
        steps: [
          {
            id: uuidv4() as UUID,
            actionName: 'MUTE_ROOM',
            parameters: {},
          },
          {
            id: uuidv4() as UUID,
            actionName: 'INVALID_ACTION',
            parameters: {},
          },
        ],
        executionModel: 'sequential',
        state: { status: 'pending' },
        metadata: { createdAt: Date.now(), constraints: [], tags: [] },
      };

      const validation = await (runtime as any).validatePlan(plan);

      expect(validation.valid).toBe(false);
      expect(validation.issues).toContain('Unknown action: INVALID_ACTION');
    });
  });

  describe('Plan Execution', () => {
    it('should execute a simple sequential plan', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: {
          text: 'Mute this room',
        },
        createdAt: Date.now(),
      };

      const plan: ActionPlan = {
        id: uuidv4() as UUID,
        goal: 'Mute room and confirm',
        steps: [
          {
            id: uuidv4() as UUID,
            actionName: 'MUTE_ROOM',
            parameters: { forceSuccess: true },
          },
          {
            id: uuidv4() as UUID,
            actionName: 'REPLY',
            parameters: {},
          },
        ],
        executionModel: 'sequential',
        state: { status: 'pending' },
        metadata: { createdAt: Date.now(), constraints: [], tags: [] },
      };

      const result = await (runtime as any).executePlan(plan, message);

      expect(result.success).toBe(true);
      expect(result.completedSteps).toBe(2);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].data?.actionName).toBe('MUTE_ROOM');
      expect(result.results[1].data?.actionName).toBe('REPLY');
    });

    it('should handle action failures gracefully', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: {
          text: 'Mute this room',
        },
        createdAt: Date.now(),
      };

      const plan: ActionPlan = {
        id: uuidv4() as UUID,
        goal: 'Mute room with failure',
        steps: [
          {
            id: uuidv4() as UUID,
            actionName: 'MUTE_ROOM',
            parameters: { forceSuccess: false },
            onError: 'continue',
          },
          {
            id: uuidv4() as UUID,
            actionName: 'REPLY',
            parameters: {},
          },
        ],
        executionModel: 'sequential',
        state: { status: 'pending' },
        metadata: { createdAt: Date.now(), constraints: [], tags: [] },
      };

      const result = await (runtime as any).executePlan(plan, message);

      expect(result.success).toBe(true);
      expect(result.completedSteps).toBe(2);
      expect(result.results[0].values?.muteSuccess).toBe(false);
    });

    it('should pass state between actions', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: {
          text: 'Update settings',
        },
        createdAt: Date.now(),
      };

      const plan: ActionPlan = {
        id: uuidv4() as UUID,
        goal: 'Update multiple settings',
        steps: [
          {
            id: uuidv4() as UUID,
            actionName: 'UPDATE_SETTINGS',
            parameters: { settingKey: 'WELCOME_CHANNEL', settingValue: '#general' },
          },
          {
            id: uuidv4() as UUID,
            actionName: 'UPDATE_SETTINGS',
            parameters: { settingKey: 'BOT_PREFIX', settingValue: '!' },
          },
          {
            id: uuidv4() as UUID,
            actionName: 'REPLY',
            parameters: {},
          },
        ],
        executionModel: 'sequential',
        state: { status: 'pending' },
        metadata: { createdAt: Date.now(), constraints: [], tags: [] },
      };

      const result = await (runtime as any).executePlan(plan, message);

      expect(result.success).toBe(true);
      expect(result.completedSteps).toBe(3);
      expect(result.results[0].values?.WELCOME_CHANNEL).toBe('#general');
      expect(result.results[1].values?.BOT_PREFIX).toBe('!');
    });
  });

  describe('Execution Order', () => {
    it('should determine correct execution order for sequential plans', () => {
      const plan: ActionPlan = {
        id: uuidv4() as UUID,
        goal: 'Sequential execution',
        steps: [
          { id: '1' as UUID, actionName: 'A', parameters: {} },
          { id: '2' as UUID, actionName: 'B', parameters: {} },
          { id: '3' as UUID, actionName: 'C', parameters: {} },
        ],
        executionModel: 'sequential',
        state: { status: 'pending' },
        metadata: { createdAt: Date.now(), constraints: [], tags: [] },
      };

      const order = getExecutionOrder(plan);

      expect(order).toHaveLength(3);
      expect(order[0]).toEqual(['1']);
      expect(order[1]).toEqual(['2']);
      expect(order[2]).toEqual(['3']);
    });

    it('should determine correct execution order for parallel plans', () => {
      const step1Id = uuidv4() as UUID;
      const step2Id = uuidv4() as UUID;
      const step3Id = uuidv4() as UUID;

      const plan: ActionPlan = {
        id: uuidv4() as UUID,
        goal: 'Parallel execution test',
        steps: [
          { id: step1Id, actionName: 'ACTION1', parameters: {} },
          { id: step2Id, actionName: 'ACTION2', parameters: {} },
          { id: step3Id, actionName: 'ACTION3', parameters: {}, dependencies: [step1Id, step2Id] },
        ],
        executionModel: 'parallel',
        state: { status: 'pending' },
        metadata: { createdAt: Date.now(), constraints: [], tags: [] },
      };

      const order = getExecutionOrder(plan);

      expect(order).toHaveLength(2);
      expect(order[0]).toContain(step1Id);
      expect(order[0]).toContain(step2Id);
      expect(order[1]).toContain(step3Id);
    });
  });
});

describe('Planning Benchmarks', () => {
  const ITERATIONS = 10;
  const results: Map<string, any[]> = new Map();

  afterEach(() => {
    // Log benchmark results
    results.forEach((scenarioResults, scenarioId) => {
      const successRate = scenarioResults.filter((r) => r.success).length / scenarioResults.length;
      const avgDuration =
        scenarioResults.reduce((sum, r) => sum + r.duration, 0) / scenarioResults.length;

      console.log(`
Scenario: ${scenarioId}
Success Rate: ${(successRate * 100).toFixed(1)}%
Average Duration: ${avgDuration.toFixed(2)}ms
      `);
    });
    results.clear();
  });

  planningScenarios.slice(0, 5).forEach((scenario) => {
    it(`should benchmark scenario: ${scenario.name}`, async () => {
      const runtime = createMockRuntime(Array.from(mockActions.values()));
      const scenarioResults: any[] = [];

      for (let i = 0; i < ITERATIONS; i++) {
        const startTime = Date.now();

        try {
          const message: Memory = {
            id: uuidv4() as UUID,
            entityId: uuidv4() as UUID,
            roomId: uuidv4() as UUID,
            content: scenario.messages[0].content,
            createdAt: Date.now(),
          };

          const context: PlanningContext = {
            goal: scenario.goal,
            constraints: [],
            availableActions: scenario.expectedActions,
            availableProviders: [],
          };

          const plan = await (runtime as any).generatePlan(message, context);
          const result = await (runtime as any).executePlan(plan, message);

          scenarioResults.push({
            iteration: i,
            success: result.success,
            duration: Date.now() - startTime,
            completedSteps: result.completedSteps,
            totalSteps: result.totalSteps,
            errors: result.errors,
          });
        } catch (error) {
          scenarioResults.push({
            iteration: i,
            success: false,
            duration: Date.now() - startTime,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      results.set(scenario.id, scenarioResults);

      // Assert minimum success rate
      const successRate = scenarioResults.filter((r) => r.success).length / scenarioResults.length;
      expect(successRate).toBeGreaterThanOrEqual(0.8); // 80% success rate minimum
    });
  });
});
