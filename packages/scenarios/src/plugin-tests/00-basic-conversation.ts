import type { Scenario } from "../types.js";

export const basicConversationScenario: Scenario = {
  id: 'basic-conversation-test',
  name: 'Basic Conversation Test',
  description: 'Test basic conversation flow between agents without external plugins',
  category: 'basic',
  tags: ['conversation', 'basic', 'no-plugins'],

  actors: [
    {
      id: 'assistant',
      name: 'Assistant',
      role: 'assistant',
      script: { steps: [] },
      character: {
        name: 'Assistant',
        bio: ['A helpful AI assistant'],
        system: 'You are a helpful AI assistant that responds to questions politely.',
      },
    },
    {
      id: 'user',
      name: 'User',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'message',
            content: 'Hello! How are you today?',
          },
          {
            type: 'wait',
            waitTime: 2000,
          },
          {
            type: 'message',
            content: 'What can you help me with?',
          },
          {
            type: 'wait',
            waitTime: 2000,
          },
          {
            type: 'message',
            content: 'Thank you for your help!',
          },
        ],
        personality: 'friendly, curious',
        goals: ['test basic conversation flow', 'verify agent responses'],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Basic Conversation',
    context: 'Simple conversation test environment',
    environment: {
      plugins: [],
    },
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
        id: 'response-count',
        type: 'deterministic' as const,
        description: 'Agent should respond to messages',
        config: {
          deterministicType: 'message_count',
          minMessages: 2,
          maxMessages: 10,
        },
        weight: 2,
      },
      {
        id: 'response-time',
        type: 'deterministic' as const,
        description: 'Agent should respond within reasonable time',
        config: {
          deterministicType: 'response_time',
          maxResponseTimeMs: 10000,
        },
        weight: 1,
      },
      {
        id: 'polite-conversation',
        type: 'deterministic' as const,
        description: 'Conversation should be polite and helpful',
        config: {
          deterministicType: 'keyword_presence',
          forbiddenKeywords: ['error', 'fail', 'cannot'],
        },
        weight: 1,
      },
    ],
    expectedOutcomes: [
      {
        actorId: 'user',
        outcome: 'Successfully had a conversation with the assistant',
        verification: {
          id: 'conversation-success',
          type: 'deterministic' as const,
          description: 'Conversation completed successfully',
          config: {
            deterministicType: 'message_count',
            minMessages: 2,
          },
        },
      },
    ],
    groundTruth: {
      expectedBehavior: 'Agent responds helpfully to user messages',
      successCriteria: [
        'Agent responds to user messages',
        'Responses are polite and helpful',
        'No errors or failures occur',
      ],
    },
  },

  benchmarks: {
    maxDuration: 60000,
    maxSteps: 10,
    maxTokens: 1000,
    targetAccuracy: 0.9,
    customMetrics: [
      { name: 'conversation_quality' },
      { name: 'response_helpfulness' },
    ],
  },
};

export default basicConversationScenario;