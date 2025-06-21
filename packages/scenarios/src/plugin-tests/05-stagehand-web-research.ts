import type { Scenario } from "../types.js";

export const stagehandWebResearchScenario: Scenario = {
  id: '8c9d0e1f-2a3b-4c5d-6e7f-8a9b0c1d2e3f',
  name: 'Automated Web Research',
  description:
    'Test Stagehand browser plugin conducting automated web research and information extraction',
  category: 'integration',
  tags: ['stagehand', 'browser', 'web-research', 'automation'],

  actors: [
    {
      id: 'd0e1f2a3-b4c5-6d7e-8f9a-0b1c2d3e4f5a',
      name: 'Web Research Agent',
      role: 'subject',
      bio: 'An AI agent specialized in automated web research and data extraction',
      system:
        'You are a web research agent that can help gather information about topics. When asked to research something, provide helpful information based on your knowledge.',
      plugins: ['@elizaos/plugin-stagehand', '@elizaos/plugin-knowledge'],
      script: { steps: [] },
    },
    {
      id: 'e1f2a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b',
      name: 'Market Researcher',
      role: 'assistant',
      script: {
        steps: [
          {
            type: 'message',
            content:
              'Can you help me research information about AI companies? I need to understand the current landscape.',
          },
          {
            type: 'wait',
            waitTime: 4000,
          },
          {
            type: 'message',
            content: 'What are some key factors I should consider when comparing AI companies?',
          },
          {
            type: 'wait',
            waitTime: 4000,
          },
          {
            type: 'message',
            content: 'Thank you! Can you summarize the main points for my report?',
          },
        ],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Market Research',
    context: 'Automated web research for competitive analysis',
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
        id: 'f2a3b4c5-d6e7-8f9a-0b1c-2d3e4f5a6b7c',
        type: 'llm' as const,
        description: 'Research assistance was provided',
        config: {
          criteria: 'The agent should have provided helpful information about AI companies',
          expectedValue: 'AI company research information',
        },
      },
      {
        id: 'a3b4c5d6-e7f8-9a0b-1c2d-3e4f5a6b7c8d',
        type: 'llm' as const,
        description: 'Comparison factors were explained',
        config: {
          criteria: 'The agent should have explained key factors for comparing AI companies',
          expectedValue: 'Comparison factors explained',
        },
      },
      {
        id: 'b4c5d6e7-f8a9-0b1c-2d3e-4f5a6b7c8d9e',
        type: 'llm' as const,
        description: 'Summary was provided',
        config: {
          criteria: 'The agent should have provided a summary of main points',
          expectedValue: 'Summary of research findings',
        },
      },
    ],
    expectedOutcomes: [
      {
        actorId: 'd0e1f2a3-b4c5-6d7e-8f9a-0b1c2d3e4f5a',
        outcome: 'Provided web research assistance',
        verification: {
          id: 'f8a9b0c1-d2e3-4f5a-6b7c-8d9e0f1a2b3c',
          type: 'llm' as const,
          description: 'Research assistance was completed',
          config: {
            criteria: 'The agent provided helpful research information and summarized findings',
          },
        },
      },
    ],
  },
};

export default stagehandWebResearchScenario;
