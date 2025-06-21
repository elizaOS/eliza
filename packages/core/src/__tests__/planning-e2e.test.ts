import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { AgentRuntime } from '../runtime';
import {
  type Action,
  type ActionResult,
  type Memory,
  type State,
  type UUID,
  type ActionPlan,
  type PlanningContext,
  type HandlerCallback,
  ModelType,
  asUUID,
  type ActionContext,
} from '../types';
import { planningScenarios } from './planning-scenarios';
import { createLogger } from '../logger';

// Create real runtime with mock actions for E2E testing
function createE2ERuntime(): AgentRuntime {
  const runtime = new AgentRuntime({
    agentId: asUUID(uuidv4()),
    character: {
      name: 'TestAgent',
      bio: ['Test agent for planning'],
      settings: {
        enablePlanning: true,
      },
    },
    settings: {
      TEST_MODE: 'true',
    },
  });

  // Register test actions
  const testActions: Action[] = [
    {
      name: 'MUTE_ROOM',
      description: 'Mute a room',
      validate: async () => true,
      handler: async (runtime, message, state, options, callback) => {
        const roomId = message.roomId;
        const success = options?.forceFailure !== true;

        // Simulate async operation
        await new Promise((resolve) => setTimeout(resolve, 100));

        if (callback) {
          await callback({
            text: success ? 'Room muted successfully' : 'Failed to mute room',
            actions: ['MUTE_ROOM'],
          });
        }

        return {
          data: {
            actionName: 'MUTE_ROOM',
            roomId,
            muted: success,
          },
          values: {
            roomMuteState: success ? 'MUTED' : 'NOT_MUTED',
            muteSuccess: success,
          },
          text: success ? 'Room muted' : 'Failed to mute room',
        };
      },
      similes: [],
      effects: {
        provides: ['room_mute_status'],
        requires: ['room_context'],
        modifies: ['participant_state'],
      },
    },
    {
      name: 'FOLLOW_ROOM',
      description: 'Follow a room',
      validate: async () => true,
      handler: async (runtime, message, state, options, callback) => {
        const roomId = message.roomId;
        const success = options?.forceFailure !== true;

        await new Promise((resolve) => setTimeout(resolve, 100));

        if (callback) {
          await callback({
            text: success ? 'Now following room' : 'Failed to follow room',
            actions: ['FOLLOW_ROOM'],
          });
        }

        return {
          data: {
            actionName: 'FOLLOW_ROOM',
            roomId,
            followed: success,
          },
          values: {
            roomFollowState: success ? 'FOLLOWED' : 'NOT_FOLLOWED',
            followSuccess: success,
          },
          text: success ? 'Room followed' : 'Failed to follow room',
        };
      },
      similes: [],
      effects: {
        provides: ['room_follow_status'],
        requires: ['room_context'],
        modifies: ['participant_state'],
      },
    },
    {
      name: 'UPDATE_SETTINGS',
      description: 'Update settings',
      validate: async () => true,
      handler: async (runtime, message, state, options, callback) => {
        const key = (options?.key || 'UNKNOWN') as string;
        const value = options?.value || 'default';

        await new Promise((resolve) => setTimeout(resolve, 50));

        if (callback) {
          await callback({
            text: `Updated ${key} to ${value}`,
            actions: ['UPDATE_SETTINGS'],
          });
        }

        return {
          data: {
            actionName: 'UPDATE_SETTINGS',
            updated: { [key]: value },
          },
          values: {
            [`setting_${key}`]: value,
            lastSettingsUpdate: Date.now(),
          },
          text: `Updated ${key} to ${value}`,
        };
      },
      similes: [],
      effects: {
        provides: ['settings_update'],
        requires: ['settings_context'],
        modifies: ['server_settings'],
      },
    },
    {
      name: 'REPLY',
      description: 'Reply to a message',
      validate: async () => true,
      handler: async (runtime, message, state, options, callback) => {
        const context = options?.context as ActionContext | undefined;
        const previousResults = context?.previousResults || [];

        let replyText = 'Task completed';
        if (previousResults.length > 0) {
          const lastResult = previousResults[previousResults.length - 1];
          replyText = `Confirmed: ${lastResult.text || 'Action completed'}`;
        }

        if (callback) {
          await callback({
            text: replyText,
            actions: ['REPLY'],
          });
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
      effects: {
        provides: ['user_response'],
        requires: ['message_context'],
        modifies: ['conversation_state'],
      },
    },
    {
      name: 'ANALYZE_MESSAGE',
      description: 'Analyze message content',
      validate: async () => true,
      handler: async (runtime, message, state, options) => {
        await new Promise((resolve) => setTimeout(resolve, 150));

        return {
          data: {
            actionName: 'ANALYZE_MESSAGE',
            analysis: {
              sentiment: 'neutral',
              intent: 'request',
              entities: [],
            },
          },
          values: {
            messageAnalyzed: true,
            analysisComplete: true,
          },
          text: 'Message analyzed',
        };
      },
      similes: [],
    },
    {
      name: 'FETCH_DATA',
      description: 'Fetch external data',
      validate: async () => true,
      handler: async (runtime, message, state, options) => {
        const dataType = options?.dataType || 'general';
        const shouldFail = options?.forceFailure === true;

        await new Promise((resolve) => setTimeout(resolve, 200));

        if (shouldFail) {
          throw new Error('Failed to fetch data');
        }

        return {
          data: {
            actionName: 'FETCH_DATA',
            dataType,
            fetchedData: { sample: 'data', timestamp: Date.now() },
          },
          values: {
            dataFetched: true,
            lastFetchTime: Date.now(),
          },
          text: `Fetched ${dataType} data`,
        };
      },
      similes: [],
    },
  ];

  // Register all test actions
  testActions.forEach((action) => runtime.registerAction(action));

  // Add model handler for plan generation
  (runtime as any).useModel = async (modelType: any, params: any) => {
    if (modelType === ModelType.TEXT_REASONING_LARGE || modelType === ModelType.TEXT_LARGE) {
      // Generate a simple plan based on the goal
      const goal = params.prompt?.includes('Mute')
        ? 'Mute the current room and inform the user'
        : params.prompt?.includes('Update')
          ? 'Update settings'
          : 'Execute requested actions';

      return `<plan>
<goal>${goal}</goal>
<steps>
<step>
<id>${uuidv4()}</id>
<action>${goal.includes('Mute') ? 'MUTE_ROOM' : 'UPDATE_SETTINGS'}</action>
<parameters>{}</parameters>
<dependencies></dependencies>
<expectedOutcome>Action completed successfully</expectedOutcome>
</step>
<step>
<id>${uuidv4()}</id>
<action>REPLY</action>
<parameters>{}</parameters>
<dependencies></dependencies>
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

describe('Planning E2E Tests', () => {
  let runtime: AgentRuntime;
  const logger = createLogger({ agentName: 'TestAgent', logLevel: 'error' });

  beforeEach(() => {
    runtime = createE2ERuntime();
  });

  describe('Simple Planning Scenarios', () => {
    it('should plan and execute mute room with confirmation', async () => {
      const message: Memory = {
        id: asUUID(uuidv4()),
        entityId: asUUID(uuidv4()),
        roomId: asUUID(uuidv4()),
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

      // Generate plan
      const plan = await (runtime as any).generatePlan(message, context);

      expect(plan).toBeDefined();
      expect(plan.goal).toBe(context.goal);
      expect(plan.steps.length).toBeGreaterThanOrEqual(2);

      // Execute plan
      const responses: any[] = [];
      const callback: HandlerCallback = async (content) => {
        responses.push(content);
        return [];
      };

      const result = await (runtime as any).executePlan(plan, message, callback);

      expect(result.success).toBe(true);
      expect(result.completedSteps).toBe(plan.steps.length);
      expect(responses).toHaveLength(plan.steps.length);
      expect(responses[0].text).toContain('muted');
      expect(responses[1].text).toContain('Confirmed');
    });

    it('should handle action failures with error recovery', async () => {
      const message: Memory = {
        id: asUUID(uuidv4()),
        entityId: asUUID(uuidv4()),
        roomId: asUUID(uuidv4()),
        content: {
          text: 'Fetch some data',
        },
        createdAt: Date.now(),
      };

      const plan: ActionPlan = {
        id: asUUID(uuidv4()),
        goal: 'Fetch data with error handling',
        steps: [
          {
            id: asUUID(uuidv4()),
            actionName: 'FETCH_DATA',
            parameters: { forceFailure: true },
            onError: 'continue',
          },
          {
            id: asUUID(uuidv4()),
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
      expect(result.errors).toBeDefined();
      expect(result.errors?.length).toBe(1);
      // The REPLY action should still execute after the failure
      // It will see the skipped error result from the previous action
      expect(result.results[1].text).toContain('Step skipped due to error');
    });
  });

  describe('Complex Planning Scenarios', () => {
    it('should execute parallel actions efficiently', async () => {
      const message: Memory = {
        id: asUUID(uuidv4()),
        entityId: asUUID(uuidv4()),
        roomId: asUUID(uuidv4()),
        content: {
          text: 'Update multiple settings',
        },
        createdAt: Date.now(),
      };

      const step1Id = asUUID(uuidv4());
      const step2Id = asUUID(uuidv4());

      const plan: ActionPlan = {
        id: asUUID(uuidv4()),
        goal: 'Update multiple settings in parallel',
        steps: [
          {
            id: step1Id,
            actionName: 'UPDATE_SETTINGS',
            parameters: { key: 'WELCOME_CHANNEL', value: '#general' },
          },
          {
            id: step2Id,
            actionName: 'UPDATE_SETTINGS',
            parameters: { key: 'BOT_PREFIX', value: '!' },
          },
          {
            id: asUUID(uuidv4()),
            actionName: 'REPLY',
            parameters: {},
            dependencies: [step1Id, step2Id],
          },
        ],
        executionModel: 'parallel',
        state: { status: 'pending' },
        metadata: { createdAt: Date.now(), constraints: [], tags: [] },
      };

      const startTime = Date.now();
      const result = await (runtime as any).executePlan(plan, message);
      const duration = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(result.completedSteps).toBe(3);
      // Parallel execution should be faster than sequential (50ms * 3)
      expect(duration).toBeLessThan(150);
    });

    it('should maintain state across action chain', async () => {
      const message: Memory = {
        id: asUUID(uuidv4()),
        entityId: asUUID(uuidv4()),
        roomId: asUUID(uuidv4()),
        content: {
          text: 'Analyze and respond',
        },
        createdAt: Date.now(),
      };

      const plan: ActionPlan = {
        id: asUUID(uuidv4()),
        goal: 'Analyze message and respond based on analysis',
        steps: [
          {
            id: asUUID(uuidv4()),
            actionName: 'ANALYZE_MESSAGE',
            parameters: {},
          },
          {
            id: asUUID(uuidv4()),
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
      expect(result.results[0].values?.analysisComplete).toBe(true);
      expect(result.results[1].text).toContain('Message analyzed');
    });
  });

  describe('Planning Benchmarks', () => {
    const ITERATIONS = 5; // Reduced for E2E tests

    planningScenarios.slice(0, 3).forEach((scenario) => {
      it(`should consistently execute scenario: ${scenario.name}`, async () => {
        const results: any[] = [];

        for (let i = 0; i < ITERATIONS; i++) {
          const message: Memory = {
            id: asUUID(uuidv4()),
            entityId: asUUID(uuidv4()),
            roomId: asUUID(uuidv4()),
            content: scenario.messages[0].content,
            createdAt: Date.now(),
          };

          const context: PlanningContext = {
            goal: scenario.goal,
            constraints: [],
            availableActions: runtime.actions.map((a) => a.name),
            availableProviders: [],
          };

          const startTime = Date.now();

          try {
            // For E2E tests, we'll create a predefined plan based on scenario
            const plan: ActionPlan = {
              id: asUUID(uuidv4()),
              goal: scenario.goal,
              steps: scenario.expectedActions.map((actionName) => ({
                id: asUUID(uuidv4()),
                actionName,
                parameters: {},
              })),
              executionModel: scenario.complexity === 'complex' ? 'parallel' : 'sequential',
              state: { status: 'pending' },
              metadata: { createdAt: Date.now(), constraints: [], tags: scenario.tags },
            };

            const result = await (runtime as any).executePlan(plan, message);

            results.push({
              iteration: i,
              success: result.success,
              duration: Date.now() - startTime,
              completedSteps: result.completedSteps,
              totalSteps: result.totalSteps,
            });
          } catch (error) {
            results.push({
              iteration: i,
              success: false,
              duration: Date.now() - startTime,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // Calculate metrics
        const successRate = results.filter((r) => r.success).length / results.length;
        const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length;

        console.log(`
Scenario: ${scenario.name}
Success Rate: ${(successRate * 100).toFixed(1)}%
Average Duration: ${avgDuration.toFixed(2)}ms
        `);

        // Assert high success rate
        expect(successRate).toBeGreaterThanOrEqual(0.8);
      });
    });
  });

  describe('Real-world Integration', () => {
    it('should handle room management workflow', async () => {
      const message: Memory = {
        id: asUUID(uuidv4()),
        entityId: asUUID(uuidv4()),
        roomId: asUUID(uuidv4()),
        content: {
          text: 'Mute this room for now, but follow the announcements channel',
        },
        createdAt: Date.now(),
      };

      const plan: ActionPlan = {
        id: asUUID(uuidv4()),
        goal: 'Manage room states',
        steps: [
          {
            id: asUUID(uuidv4()),
            actionName: 'MUTE_ROOM',
            parameters: {},
          },
          {
            id: asUUID(uuidv4()),
            actionName: 'FOLLOW_ROOM',
            parameters: { roomId: 'announcements' },
          },
          {
            id: asUUID(uuidv4()),
            actionName: 'REPLY',
            parameters: {},
          },
        ],
        executionModel: 'sequential',
        state: { status: 'pending' },
        metadata: { createdAt: Date.now(), constraints: [], tags: ['room-management'] },
      };

      const responses: any[] = [];
      const callback: HandlerCallback = async (content) => {
        responses.push(content);
        return [];
      };

      const result = await (runtime as any).executePlan(plan, message, callback);

      expect(result.success).toBe(true);
      expect(result.completedSteps).toBe(3);
      expect(responses[0].text).toContain('muted');
      expect(responses[1].text).toContain('following');
      expect(responses[2].text).toContain('Confirmed');
    });
  });
});
