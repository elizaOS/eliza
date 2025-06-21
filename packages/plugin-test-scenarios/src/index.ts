import type { Plugin, PluginScenario } from '@elizaos/core';

// Define some basic scenarios to test the system
const testScenarios: PluginScenario[] = [
  {
    id: 'a1b2c3d4-e5f6-7890-abcd-123456789012',
    name: 'Basic Greeting Test',
    description: 'Test basic greeting functionality',
    characters: [
      {
        id: 'a1b2c3d4-e5f6-7890-abcd-123456789013',
        name: 'Test Agent',
        role: 'subject',
        bio: 'A simple test agent for scenario validation',
        system: 'You are a friendly test agent. Respond to greetings warmly.',
        plugins: [], // No plugin dependencies
        messageExamples: [
          [
            { user: 'user', content: { text: 'Hello' } },
            { user: 'Test Agent', content: { text: 'Hello! How can I help you today?' } }
          ]
        ]
      },
      {
        id: 'a1b2c3d4-e5f6-7890-abcd-123456789014',
        name: 'Test User',
        role: 'observer',
        bio: 'A test user for scenarios',
        system: 'You are a test user',
        plugins: []
      }
    ],
    script: {
      steps: [
        {
          id: 'initial-greeting',
          type: 'message',
          from: 'a1b2c3d4-e5f6-7890-abcd-123456789014',
          content: 'Hello there!'
        },
        {
          id: 'wait-response',
          type: 'wait',
          duration: 1000
        }
      ]
    },
    verification: {
      rules: [
        {
          id: 'response-exists',
          type: 'llm',
          description: 'Agent should respond to greeting',
          config: {
            successCriteria: 'The agent provided a friendly response to the greeting'
          }
        }
      ]
    },
    requiredEnvVars: []
  },
  {
    id: 'a1b2c3d4-e5f6-7890-abcd-123456789015',
    name: 'Multi-Step Conversation',
    description: 'Test a more complex multi-step conversation',
    characters: [
      {
        id: 'a1b2c3d4-e5f6-7890-abcd-123456789016',
        name: 'Helpful Agent',
        role: 'subject',
        bio: 'A helpful assistant that provides information',
        system: 'You are a helpful assistant. Answer questions clearly and concisely.',
        plugins: [], // No plugin dependencies
        messageExamples: [
          [
            { user: 'user', content: { text: 'What is the weather like?' } },
            { user: 'Helpful Agent', content: { text: 'I don\'t have access to real-time weather data, but I can help you find weather information.' } }
          ]
        ]
      }
    ],
    script: {
      steps: [
        {
          id: 'ask-question',
          type: 'message',
          from: 'a1b2c3d4-e5f6-7890-abcd-123456789014',
          content: 'Can you tell me about yourself?'
        },
        {
          id: 'wait-response-1',
          type: 'wait',
          duration: 1500
        },
        {
          id: 'follow-up',
          type: 'message',
          from: 'a1b2c3d4-e5f6-7890-abcd-123456789014',
          content: 'What can you help me with?'
        },
        {
          id: 'wait-response-2',
          type: 'wait',
          duration: 1000
        }
      ]
    },
    verification: {
      rules: [
        {
          id: 'multiple-responses',
          type: 'llm',
          description: 'Agent should respond to both questions',
          config: {
            successCriteria: 'The agent provided meaningful responses to both questions asked'
          }
        }
      ]
    },
    requiredEnvVars: []
  }
];

export const testScenariosPlugin: Plugin = {
  name: '@elizaos/plugin-test-scenarios',
  description: 'Test plugin with example scenarios for the new plugin scenario system',
  
  scenarios: testScenarios,

  async init(config: Record<string, string>, runtime: any): Promise<void> {
    console.log('Test scenarios plugin initialized with', testScenarios.length, 'scenarios');
  },
};

export default testScenariosPlugin;