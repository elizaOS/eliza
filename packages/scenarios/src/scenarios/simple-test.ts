import type { Scenario } from '@elizaos/cli';

/**
 * Simple test scenario to validate scenario runner functionality
 */
export const simpleTestScenario: Scenario = {
  id: 'simple-test',
  name: 'Simple Test',
  description: 'Basic scenario to test scenario runner functionality',
  tags: ['basic', 'test'],

  actors: [
    {
      id: 'user-1' as any,
      name: 'User1',
      role: 'adversary', // This actor will send messages
      script: {
        steps: [
          {
            type: 'message',
            content: 'Hello, how are you?',
            description: 'Send initial greeting',
          },
          {
            type: 'wait',
            waitTime: 2000,
            description: 'Wait for response',
          }
        ]
      }
    },
    {
      id: 'test-agent' as any,
      name: 'TestAgent',
      role: 'subject', // This is the agent being tested
      bio: 'A helpful assistant',
      system: 'You are a helpful assistant. Respond to messages politely and helpfully.',
      plugins: ['@elizaos/plugin-sql']
    }
  ],

  setup: {
    roomType: 'group',
    roomName: 'Test Room',
    context: 'A simple test environment'
  },

  execution: {
    maxDuration: 30000, // 30 seconds
    maxSteps: 10,
    timeout: 5000
  },

  verification: {
    rules: [
      {
        id: 'response-check',
        type: 'llm',
        description: 'Agent should respond to greeting',
        config: {
          successCriteria: 'Agent responds politely to greeting',
          minMessages: 1,
          requiredKeywords: [],
          forbiddenKeywords: ['error', 'failed']
        },
        weight: 1
      }
    ]
  },

  benchmarks: {
    maxDuration: 10000,
    maxSteps: 5,
    targetAccuracy: 0.8
  }
};

export default simpleTestScenario;