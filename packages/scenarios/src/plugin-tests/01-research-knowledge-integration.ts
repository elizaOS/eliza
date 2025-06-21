import type { Scenario } from "../types.js";

export const researchKnowledgeIntegrationScenario: Scenario = {
  id: '6fbc1f01-8e44-42bf-afa0-57b619012067',
  name: 'Academic Paper Research and Knowledge Storage',
  description:
    'Test research plugin conducting deep research, then storing findings in knowledge base for future retrieval',
  category: 'integration',
  tags: ['research', 'knowledge', 'multi-plugin', 'action-chaining'],

  actors: [
    {
      id: '57783c5e-6b70-4e3b-899c-1412cfb55cbd',
      name: 'Research Agent',
      role: 'subject',
      bio: 'A specialized research assistant with academic expertise',
      system:
        'You are a helpful research assistant. When asked about AI in education, provide a thoughtful response based on your knowledge. You have access to research and knowledge management tools but may not always need to use them.',
      plugins: ['@elizaos/plugin-research', '@elizaos/plugin-knowledge'],
      script: { steps: [] },
    },
    {
      id: '88a9bcd0-1234-5678-90ef-ghijklmnopqr',
      name: 'Research Tester',
      role: 'assistant',
      script: {
        steps: [
          {
            type: 'message',
            content:
              'Hello! Can you tell me about the impact of artificial intelligence on modern education?',
          },
          {
            type: 'wait',
            waitTime: 5000, // Wait 5 seconds for response
          },
          {
            type: 'message',
            content: 'Thank you for that information. Can you summarize the key points?',
          },
        ],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Research Test Room',
    context: 'Academic research environment',
  },

  execution: {
    maxDuration: 60000, // 1 minute
    maxSteps: 20,
    stopConditions: [
      {
        type: 'message_count',
        value: 4, // 2 messages from user, 2 responses from agent
        description: 'Stop after 4 messages exchanged',
      },
    ],
  },

  verification: {
    rules: [
      {
        id: 'rule-1',
        type: 'llm',
        description: 'Agent must respond to the initial query',
        config: {
          criteria: 'Check if the agent provided a response about AI in education',
          expectedValue: 'Response about AI in education',
        },
      },
      {
        id: 'rule-2',
        type: 'llm',
        description: 'Agent must provide a summary when asked',
        config: {
          criteria: 'Verify that the agent provided a summary of key points when requested',
          expectedValue: 'Summary provided',
        },
      },
      {
        id: 'rule-3',
        type: 'llm',
        description: 'Responses should be informative and relevant',
        config: {
          criteria:
            'Confirm that the agent responses are informative, relevant to AI in education, and well-structured',
          expectedValue: 'Informative and relevant responses',
        },
      },
    ],
    expectedOutcomes: [
      {
        actorId: '57783c5e-6b70-4e3b-899c-1412cfb55cbd',
        outcome: 'Provided information about AI in education',
        verification: {
          id: 'outcome-1',
          type: 'llm',
          description: 'Research information was shared',
          config: {
            criteria: 'The agent shared information about AI in education and provided a summary',
          },
        },
      },
    ],
  },
};

export default researchKnowledgeIntegrationScenario;
