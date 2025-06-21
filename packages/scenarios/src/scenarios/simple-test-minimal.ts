import type { Scenario } from '@elizaos/cli';

/**
 * Minimal test scenario to debug model loading issues
 */
export const minimalTestScenario: Scenario = {
  id: 'minimal-test',
  name: 'Minimal Test',
  description: 'Minimal scenario to debug model registration',
  tags: ['minimal', 'debug'],

  actors: [
    {
      id: 'test-agent' as any,
      name: 'TestAgent',
      role: 'subject', // This is the agent being tested
      bio: 'A minimal test agent',
      system: 'You are a test agent. Always respond with "Hello" when someone greets you.',
      plugins: ['@elizaos/plugin-openai'] // Explicitly include OpenAI plugin
    },
    {
      id: 'user-actor' as any,
      name: 'TestUser',
      role: 'assistant', // This actor will interact with the test agent
      bio: 'A simulated user for testing',
      system: 'You are a test user. Send simple messages to test the agent.',
      plugins: ['@elizaos/plugin-openai'],
      script: {
        steps: [
          {
            id: 'greeting',
            type: 'message',
            content: 'Hello, are you working?',
            description: 'Send initial greeting to test agent',
            timeout: 5000,
            critical: true
          },
          {
            id: 'wait-response',
            type: 'wait',
            waitTime: 3000,
            description: 'Wait for agent response'
          }
        ],
        goals: ['Test basic agent responsiveness', 'Verify model handlers are working'],
        personality: 'Direct and testing-focused'
      }
    }
  ],

  setup: {
    roomType: 'group',
    roomName: 'Test Room'
  },

  execution: {
    maxDuration: 15000, // 15 seconds
    maxSteps: 10
  },

  verification: {
    rules: [
      {
        id: 'basic-check',
        type: 'llm',
        description: 'Basic functionality check',
        config: {
          successCriteria: 'Agent should respond appropriately to messages and show it can process text using LLM capabilities',
        },
        weight: 1
      },
      {
        id: 'response-check',
        type: 'llm',
        description: 'Response content verification',
        config: {
          successCriteria: 'Agent should include "Hello" in response as instructed by its system prompt',
          requiredKeywords: ['Hello'],
        },
        weight: 1
      }
    ]
  }
};

export default minimalTestScenario;