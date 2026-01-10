import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { createMockRuntime as createCoreMockRuntime } from '@elizaos/core/test-utils';
import { v4 as uuidv4 } from 'uuid';

export function createMockRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  // Use the unified mock runtime from core with planning-specific overrides
  return createCoreMockRuntime({
    // Planning-specific settings
    getSetting: (key: string) => {
      const defaultSettings: Record<string, any> = {
        OPENAI_API_KEY: 'test-api-key',
        MODEL_NAME: 'gpt-4',
        PLANNING_TIMEOUT: '30000',
        LOG_LEVEL: 'info',
      };
      return defaultSettings[key] || null;
    },

    // Mock the useModel method to return predictable responses for planning tests
    useModel: (modelType: string, params: any) => {
      // Mock planning responses based on the prompt content
      const prompt = params.prompt || '';

      // Check if this is a comprehensive planning prompt (contains XML structure)
      if (prompt.includes('<plan>') && prompt.includes('AVAILABLE ACTIONS:')) {
        // Extract available actions from the prompt
        const actionsMatch = prompt.match(/AVAILABLE ACTIONS:\s*([^\n]+)/);
        const actions = actionsMatch
          ? actionsMatch[1]
              .split(',')
              .map((a: string) => a.trim())
              .filter(Boolean)
          : ['REPLY'];

        // Generate comprehensive plan with multiple steps
        if (actions.length > 1) {
          const steps = actions
            .slice(0, 3)
            .map(
              (action: string, index: number) => `<step>
<id>step_${index + 1}</id>
<action>${action}</action>
<parameters>{"param": "value_${index + 1}"}</parameters>
<dependencies>${index > 0 ? `["step_${index}"]` : '[]'}</dependencies>
<description>Execute ${action} action</description>
</step>`
            )
            .join('\n');

          // Extract goal from prompt
          const goalMatch = prompt.match(/GOAL:\s*([^\n]+)/);
          const goal = goalMatch
            ? goalMatch[1].trim()
            : 'Execute comprehensive plan with available actions';

          return Promise.resolve(`<plan>
<goal>${goal}</goal>
<execution_model>${prompt.includes('parallel') ? 'parallel' : prompt.includes('dag') ? 'dag' : 'sequential'}</execution_model>
<steps>
${steps}
</steps>
<estimated_duration>15000</estimated_duration>
</plan>`);
        }
      }

      // Simple planning responses (no XML structure expected)
      if (prompt.includes('Send an email') || prompt.includes('email')) {
        return Promise.resolve('Send email action detected');
      }

      if (prompt.includes('research') || prompt.includes('search')) {
        return Promise.resolve('Research action detected');
      }

      // Default response
      return Promise.resolve('Default action response');
    },

    // Planning-specific services
    getService: (name: string) => {
      const services: Record<string, any> = {
        planning: {
          createSimplePlan: async (runtime: any, message: any, state: any) => {
            // Mock based on message content
            const text = message?.content?.text || '';
            if (text.includes('send email')) {
              return {
                id: 'test-plan-id',
                goal: 'Execute actions: SEND_EMAIL',
                title: 'Email Plan',
                description: 'Send email task',
                steps: [
                  {
                    id: 'step-1',
                    action: 'SEND_EMAIL',
                    description: 'Send email',
                    status: 'pending',
                  },
                ],
              };
            }
            if (text.includes('research') || text.includes('search')) {
              return {
                id: 'test-plan-id',
                goal: 'Execute actions: SEARCH, REPLY',
                title: 'Research Plan',
                description: 'Research and reply task',
                steps: [
                  {
                    id: 'step-1',
                    action: 'SEARCH',
                    description: 'Search for information',
                    status: 'pending',
                  },
                  {
                    id: 'step-2',
                    action: 'REPLY',
                    description: 'Reply with findings',
                    status: 'pending',
                  },
                ],
              };
            }
            return {
              id: 'test-plan-id',
              goal: 'Execute actions: REPLY',
              title: 'Simple Plan',
              description: 'Basic task plan',
              steps: [
                { id: 'step-1', action: 'REPLY', description: 'Reply to user', status: 'pending' },
              ],
            };
          },
          createComprehensivePlan: async () => ({
            id: 'comprehensive-plan-id',
            title: 'Comprehensive Test Plan',
            description: 'A comprehensive test planning scenario',
            steps: [],
            metadata: {},
          }),
          executePlan: async () => ({ success: true, executedSteps: 2 }),
          validatePlan: async () => ({ isValid: true, errors: [] }),
          adaptPlan: async () => ({ adapted: true, changes: [] }),
        },
        memory: {
          getMemories: async () => [],
          createMemory: async () => true,
          searchMemories: async () => [],
        },
        ...(overrides as any)?.services,
      };
      return services[name];
    },

    // Default actions for validation
    actions: [
      {
        name: 'REPLY',
        description: 'Send a reply',
        handler: async () => ({ text: 'Reply sent' }),
        validate: async () => true,
      },
      {
        name: 'SEND_EMAIL',
        description: 'Send an email',
        handler: async () => ({ text: 'Email sent' }),
        validate: async () => true,
      },
      {
        name: 'SEARCH',
        description: 'Search for information',
        handler: async () => ({ text: 'Search completed' }),
        validate: async () => true,
      },
      ...(overrides.actions || []),
    ],

    ...overrides,
  }) as any;
}

export function createMockMemory(content: any = {}): Memory {
  return {
    id: uuidv4(),
    entityId: uuidv4(),
    content: {
      text: 'test message',
      ...content,
    },
    agentId: uuidv4(),
    roomId: uuidv4(),
    createdAt: Date.now(),
  } as Memory;
}

export function createMockState(): State {
  return {
    values: {},
    data: {},
    text: '',
  } as State;
}

export function createMockPlanningContext() {
  return {
    goal: 'Test planning goal',
    constraints: [],
    availableActions: ['REPLY', 'THINK', 'SEARCH'],
    availableProviders: ['TIME', 'MEMORY'],
    preferences: {
      executionModel: 'sequential' as const,
      maxSteps: 10,
      timeoutMs: 30000,
    },
  };
}
