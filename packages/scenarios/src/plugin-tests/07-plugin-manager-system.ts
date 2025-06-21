import type { Scenario } from "../types.js";

export const pluginManagerSystemScenario: Scenario = {
  id: 'd9e0f1a2-b3c4-5d6e-7f8a-9b0c1d2e3f4a',
  name: 'Dynamic Plugin Management System',
  description:
    'Test plugin manager discovering, installing, updating, and managing plugins dynamically',
  category: 'integration',
  tags: ['plugin-manager', 'system', 'dynamic-loading', 'lifecycle'],

  actors: [
    {
      id: 'e0f1a2b3-c4d5-6e7f-8a9b-0c1d2e3f4a5b',
      name: 'System Administrator Agent',
      role: 'subject',
      bio: 'A system administration agent that manages plugins and system configuration',
      system:
        'You are a system administrator agent that helps with plugin management questions. When asked about plugins, provide helpful information about managing and configuring them.',
      plugins: ['@elizaos/plugin-plugin-manager'],
      script: { steps: [] },
    },
    {
      id: 'f1a2b3c4-d5e6-7f8a-9b0c-1d2e3f4a5b6c',
      name: 'DevOps Engineer',
      role: 'assistant',
      script: {
        steps: [
          {
            type: 'message',
            content: 'Hi! I need help understanding how to manage plugins in the system.',
          },
          {
            type: 'wait',
            waitTime: 3000,
          },
          {
            type: 'message',
            content: 'What are the best practices for installing and updating plugins?',
          },
          {
            type: 'wait',
            waitTime: 3000,
          },
          {
            type: 'message',
            content: 'How can I check for plugin compatibility and dependencies?',
          },
        ],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'System Administration',
    context: 'Managing plugin lifecycle and system configuration',
  },

  execution: {
    maxDuration: 60000, // 1 minute
    maxSteps: 10,
    stopConditions: [
      {
        type: 'message_count',
        value: 6,
        description: 'Stop after 6 messages exchanged',
      },
    ],
  },

  verification: {
    rules: [
      {
        id: 'a2b3c4d5-e6f7-8a9b-0c1d-2e3f4a5b6c7d',
        type: 'llm' as const,
        description: 'Plugin management help was provided',
        config: {
          criteria: 'The agent should have provided helpful information about managing plugins',
          expectedValue: 'Plugin management guidance',
        },
      },
      {
        id: 'b3c4d5e6-f7a8-9b0c-1d2e-3f4a5b6c7d8e',
        type: 'llm' as const,
        description: 'Best practices were explained',
        config: {
          criteria:
            'The agent should have explained best practices for installing and updating plugins',
          expectedValue: 'Best practices explained',
        },
      },
      {
        id: 'c4d5e6f7-a8b9-0c1d-2e3f-4a5b6c7d8e9f',
        type: 'llm' as const,
        description: 'Compatibility guidance was provided',
        config: {
          criteria:
            'The agent should have explained how to check plugin compatibility and dependencies',
          expectedValue: 'Compatibility guidance provided',
        },
      },
    ],
    expectedOutcomes: [
      {
        actorId: 'e0f1a2b3-c4d5-6e7f-8a9b-0c1d2e3f4a5b',
        outcome: 'Provided plugin management guidance',
        verification: {
          id: 'b9c0d1e2-f3a4-5b6c-7d8e-9f0a1b2c3d4e',
          type: 'llm' as const,
          description: 'Plugin management assistance was provided',
          config: {
            criteria:
              'The agent provided helpful information about plugin management, best practices, and compatibility',
          },
        },
      },
    ],
  },
};

export default pluginManagerSystemScenario;
