import type { Scenario } from "../types.js";

export const planningExecutionScenario: Scenario = {
  id: '7f8e9d0c-1a2b-3c4d-5e6f-7a8b9c0d1e2f',
  name: 'Comprehensive Planning',
  description:
    'Test planning plugin creating comprehensive plans that are executed through multiple plugins',
  category: 'integration',
  tags: ['planning', 'multi-plugin', 'orchestration', 'complex-workflow'],

  actors: [
    {
      id: '9a0b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d',
      name: 'Strategic Planning Agent',
      role: 'subject',
      bio: 'A strategic planning AI that orchestrates complex multi-step workflows',
      system:
        'You are a strategic planning agent that helps create plans and coordinate tasks. When asked to plan something, provide thoughtful structured responses.',
      plugins: [
        '@elizaos/plugin-planning',
        '@elizaos/plugin-research',
        '@elizaos/plugin-knowledge',
        '@elizaos/plugin-github',
      ],
      script: { steps: [] },
    },
    {
      id: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
      name: 'Business Analyst',
      role: 'assistant',
      script: {
        steps: [
          {
            type: 'message',
            content:
              'I need help planning a new feature for our application. Can you help me create a plan?',
          },
          {
            type: 'wait',
            waitTime: 4000,
          },
          {
            type: 'message',
            content: 'Great! Can you break down the main phases we should consider?',
          },
          {
            type: 'wait',
            waitTime: 4000,
          },
          {
            type: 'message',
            content: 'What should be our first priority to get started?',
          },
        ],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Strategic Planning Session',
    context: 'Enterprise software development planning and execution',
  },

  execution: {
    maxDuration: 60000, // 1 minute
    maxSteps: 15,
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
        id: 'b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e',
        type: 'llm' as const,
        description: 'Planning assistance was provided',
        config: {
          criteria: 'The agent should have provided helpful planning assistance when asked',
          expectedValue: 'Planning help provided',
        },
      },
      {
        id: 'c3d4e5f6-a7b8-9c0d-1e2f-3a4b5c6d7e8f',
        type: 'llm' as const,
        description: 'Phases were outlined',
        config: {
          criteria: 'The agent should have outlined main phases or steps when asked',
          expectedValue: 'Phases explained',
        },
      },
      {
        id: 'd4e5f6a7-b8c9-0d1e-2f3a-4b5c6d7e8f9a',
        type: 'llm' as const,
        description: 'Priorities were identified',
        config: {
          criteria: 'The agent should have identified priorities or first steps',
          expectedValue: 'Priorities identified',
        },
      },
    ],
    expectedOutcomes: [
      {
        actorId: '9a0b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d',
        outcome: 'Provided strategic planning assistance',
        verification: {
          id: 'c9d0e1f2-a3b4-5c6d-7e8f-9a0b1c2d3e4f',
          type: 'llm' as const,
          description: 'Planning guidance was provided',
          config: {
            criteria:
              'The agent provided helpful planning guidance including phases and priorities',
          },
        },
      },
    ],
  },
};

export default planningExecutionScenario;
