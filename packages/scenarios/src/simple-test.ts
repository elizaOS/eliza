import type { Scenario } from "./types.js";

export const simpleTestScenario: Scenario = {
  id: 'simple-test',
  name: 'Simple Test Scenario',
  description: 'A basic test scenario to verify the framework works',
  category: 'testing',
  tags: ['test', 'basic'],
  
  actors: [
    {
      id: 'test-agent',
      name: 'Test Agent',
      role: 'subject',
      systemPrompt: 'You are a helpful test agent. Respond concisely.',
    },
    {
      id: 'user',
      name: 'User',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'message',
            content: 'Hello, can you help me test something?',
            timing: 1000,
          },
          {
            type: 'wait',
            waitTime: 2000,
          },
          {
            type: 'message',
            content: 'What is 2 + 2?',
            timing: 1000,
          },
        ],
      },
    },
  ],
  
  setup: {
    roomName: 'Test Room',
    roomType: 'direct',
    initialContext: {
      purpose: 'testing',
    },
  },
  
  execution: {
    maxDuration: 30000, // 30 seconds
    maxSteps: 10,
    strategy: 'sequential',
  },
  
  verification: {
    strategy: 'combined',
    confidence: 0.7,
    rules: [
      {
        id: 'greeting-response',
        type: 'pattern',
        description: 'Agent should respond to greeting',
        config: {
          pattern: 'hello|hi|help',
          mustInclude: true,
        },
      },
      {
        id: 'math-answer',
        type: 'pattern',
        description: 'Agent should correctly answer 2 + 2',
        config: {
          pattern: '4|four',
          mustInclude: true,
        },
      },
    ],
  },
  
  benchmarks: {
    responseTime: 5000,
    completionTime: 30000,
    successRate: 1.0,
  },
};

export default simpleTestScenario;