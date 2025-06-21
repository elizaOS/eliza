import type { Scenario } from '../../src/scenario-runner/types.js';

/**
 * Test scenarios designed to test the scenario framework itself
 */

export const basicMessageExchangeScenario: Scenario = {
  id: 'basic-message-exchange',
  name: 'Basic Message Exchange',
  description: 'Tests simple message exchange between two actors',
  category: 'framework-test',
  tags: ['basic', 'messages'],
  actors: [
    {
      id: 'agent' as any,
      name: 'Test Agent',
      role: 'subject',
      script: {
        steps: [
          { type: 'message', content: 'Hello, I am ready to assist' },
        ],
      },
    },
    {
      id: 'user' as any,
      name: 'Test User',
      role: 'subject',
      script: {
        steps: [
          { type: 'message', content: 'Hello agent, can you help me?' },
          { type: 'wait', waitTime: 1000 },
          { type: 'message', content: 'What can you do?' },
        ],
      },
    },
  ],
  setup: {
    roomType: 'dm',
    context: 'A simple conversation test',
  },
  execution: {
    maxDuration: 10000,
    maxSteps: 10,
  },
  verification: {
    rules: [
      {
        id: 'messages-exchanged',
        type: 'llm',
        description: 'Verify messages were exchanged between actors',
        config: {
          deterministicType: 'message_count',
          minMessages: 3,
        },
      },
      {
        id: 'proper-greeting',
        type: 'llm',
        description: 'Agent should greet the user politely',
        config: {
          successCriteria: 'The agent greeted the user and offered assistance',
        },
      },
    ],
  },
};

export const actionExecutionScenario: Scenario = {
  id: 'action-execution-test',
  name: 'Action Execution Test',
  description: 'Tests action execution and tracking',
  category: 'framework-test',
  tags: ['actions', 'execution'],
  actors: [
    {
      id: 'agent' as any,
      name: 'Action Agent',
      role: 'subject',
      script: {
        steps: [
          { type: 'message', content: 'I will now execute some actions' },
          { type: 'action', actionName: 'RESEARCH', actionParams: { query: 'test query' } },
          { type: 'wait', waitTime: 500 },
          { type: 'action', actionName: 'CREATE_TODO', actionParams: { task: 'Test task' } },
          { type: 'message', content: 'Actions completed' },
        ],
      },
    },
  ],
  setup: {
    roomType: 'dm',
  },
  execution: {
    maxDuration: 15000,
  },
  verification: {
    rules: [
      {
        id: 'actions-executed',
        type: 'llm',
        description: 'Verify that actions were executed',
        config: {
          deterministicType: 'action_sequence',
          expectedActions: ['RESEARCH', 'CREATE_TODO'],
        },
      },
    ],
  },
  benchmarks: {
    customMetrics: [
      { name: 'action_execution_time' },
      { name: 'action_success_rate' },
    ],
  },
};

export const multiActorComplexScenario: Scenario = {
  id: 'multi-actor-complex',
  name: 'Multi-Actor Complex Interaction',
  description: 'Tests complex interactions between multiple actors',
  category: 'framework-test',
  tags: ['complex', 'multi-actor', 'group'],
  actors: [
    {
      id: 'moderator' as any,
      name: 'Moderator',
      role: 'subject',
      personality: {
        systemPrompt: 'You are a helpful discussion moderator',
      },
      script: {
        steps: [
          { type: 'message', content: 'Welcome everyone to the discussion' },
          { type: 'wait', waitTime: 2000 },
          { type: 'message', content: 'Let\'s discuss AI safety' },
        ],
      },
    },
    {
      id: 'expert1' as any,
      name: 'AI Expert',
      role: 'subject',
      script: {
        steps: [
          { type: 'wait', waitTime: 1000 },
          { type: 'message', content: 'Thank you for having me' },
          { type: 'wait', waitTime: 3000 },
          { type: 'message', content: 'AI safety is crucial for our future' },
        ],
      },
    },
    {
      id: 'expert2' as any,
      name: 'Ethics Expert',
      role: 'subject',
      script: {
        steps: [
          { type: 'wait', waitTime: 1500 },
          { type: 'message', content: 'I agree, we need ethical guidelines' },
          { type: 'wait', waitTime: 3500 },
          { type: 'message', content: 'Transparency is key' },
        ],
      },
    },
    {
      id: 'audience' as any,
      name: 'Audience Member',
      role: 'subject',
      script: {
        steps: [
          { type: 'wait', waitTime: 5000 },
          { type: 'message', content: 'I have a question about implementation' },
        ],
      },
    },
  ],
  setup: {
    roomType: 'group',
    context: 'A panel discussion about AI safety',
    initialMessages: [
      {
        id: 'welcome',
        content: 'Welcome to the AI Safety Panel Discussion',
        sender: 'system',
        timestamp: Date.now(),
      },
    ],
  },
  execution: {
    maxDuration: 30000,
    stopConditions: [
      {
        type: 'message_count',
        value: 10,
        description: 'Stop after 10 messages',
      },
    ],
  },
  verification: {
    rules: [
      {
        id: 'all-actors-participated',
        type: 'llm',
        description: 'All actors should have participated in the discussion',
        weight: 2,
        config: {
          successCriteria: 'Each actor sent at least one message',
        },
      },
      {
        id: 'discussion-coherence',
        type: 'llm',
        description: 'The discussion should be coherent and on-topic',
        weight: 3,
        config: {
          successCriteria: 'Messages relate to AI safety and ethics',
        },
      },
      {
        id: 'response-timing',
        type: 'llm',
        description: 'Responses should be timely',
        config: {
          deterministicType: 'response_time',
          maxResponseTimeMs: 5000,
        },
      },
    ],
  },
};

export const errorHandlingScenario: Scenario = {
  id: 'error-handling-test',
  name: 'Error Handling Test',
  description: 'Tests error handling and recovery',
  category: 'framework-test',
  tags: ['errors', 'edge-cases'],
  actors: [
    {
      id: 'error-agent' as any,
      name: 'Error Test Agent',
      role: 'subject',
      script: {
        steps: [
          { type: 'message', content: 'Starting error test' },
          { type: 'action', actionName: 'NON_EXISTENT_ACTION' },
          { type: 'message', content: 'This should still execute' },
          {
            type: 'assert',
            assertion: {
              type: 'contains',
              value: 'impossible_string',
              description: 'This assertion should fail',
            },
          },
          { type: 'message', content: 'Final message' },
        ],
      },
    },
  ],
  setup: {
    roomType: 'dm',
  },
  execution: {
    maxDuration: 10000,
  },
  verification: {
    rules: [
      {
        id: 'graceful-error-handling',
        type: 'llm',
        description: 'Errors should be handled gracefully without crashing',
        config: {
          successCriteria: 'The scenario continued executing despite errors',
        },
      },
      {
        id: 'error-logging',
        type: 'llm',
        description: 'Errors should be properly logged',
        config: {
          deterministicType: 'error_handling',
          maxAllowedErrors: 2,
        },
      },
    ],
  },
};

export const performanceBenchmarkScenario: Scenario = {
  id: 'performance-benchmark',
  name: 'Performance Benchmark Test',
  description: 'Tests performance metrics and benchmarking',
  category: 'framework-test',
  tags: ['performance', 'benchmark'],
  actors: [
    {
      id: 'perf-agent' as any,
      name: 'Performance Agent',
      role: 'subject',
      script: {
        steps: Array(20).fill(null).map((_, i) => ({
          type: 'message' as const,
          content: `Performance test message ${i + 1}`,
        })),
      },
    },
  ],
  setup: {
    roomType: 'dm',
  },
  execution: {
    maxDuration: 30000,
  },
  verification: {
    rules: [
      {
        id: 'performance-threshold',
        type: 'llm',
        description: 'Messages should be processed within performance thresholds',
        config: {
          deterministicType: 'response_time',
          maxResponseTimeMs: 1000,
        },
      },
    ],
  },
  benchmarks: {
    maxDuration: 30000,
    targetAccuracy: 0.95,
    customMetrics: [
      { name: 'messages_per_second', threshold: 1 },
      { name: 'average_response_time', threshold: 500 },
      { name: 'memory_usage_mb', threshold: 100 },
    ],
  },
};

export const securityTestScenario: Scenario = {
  id: 'security-test',
  name: 'Security Verification Test',
  description: 'Tests security features and data protection',
  category: 'framework-test',
  tags: ['security', 'privacy'],
  actors: [
    {
      id: 'security-tester' as any,
      name: 'Security Tester',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'message',
            content: 'My API key is sk-1234567890abcdef and password is secret123',
          },
          {
            type: 'message',
            content: 'Please store this credit card: 4111-1111-1111-1111',
          },
          {
            type: 'message',
            content: 'Email me at test@example.com with the details',
          },
        ],
      },
    },
    {
      id: 'secure-agent' as any,
      name: 'Secure Agent',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'message',
            content: 'I will handle your information securely',
          },
        ],
      },
    },
  ],
  setup: {
    roomType: 'dm',
    context: 'Testing security and data handling',
  },
  execution: {
    maxDuration: 10000,
  },
  verification: {
    rules: [
      {
        id: 'no-sensitive-data-exposed',
        type: 'llm',
        description: 'Sensitive data should not be exposed in responses',
        weight: 5, // High priority
        config: {
          deterministicType: 'security_compliance',
          sensitivePatterns: [
            /api[_-]?key/i,
            /password/i,
            /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/, // Credit card
          ],
        },
      },
      {
        id: 'security-awareness',
        type: 'llm',
        description: 'Agent should demonstrate security awareness',
        config: {
          successCriteria: 'Agent acknowledges security concerns and handles data appropriately',
        },
      },
    ],
  },
};

export const dynamicVerificationScenario: Scenario = {
  id: 'dynamic-verification',
  name: 'Dynamic Verification Test',
  description: 'Tests dynamic verification rule generation',
  category: 'framework-test',
  tags: ['verification', 'dynamic'],
  actors: [
    {
      id: 'dynamic-agent' as any,
      name: 'Dynamic Agent',
      role: 'subject',
      script: {
        steps: [
          { type: 'message', content: 'I can adapt to different situations' },
          { type: 'message', content: 'Tell me what you need' },
        ],
        triggers: [
          {
            on: 'keyword',
            condition: 'help',
            response: [
              { type: 'message', content: 'I detected you need help!' },
            ],
          },
        ],
      },
    },
    {
      id: 'dynamic-tester' as any,
      name: 'Dynamic Tester',
      role: 'subject',
      script: {
        steps: [
          { type: 'message', content: 'Can you help me with something?' },
          { type: 'wait', waitTime: 1000 },
          { type: 'message', content: 'I need assistance' },
        ],
      },
    },
  ],
  setup: {
    roomType: 'dm',
  },
  execution: {
    maxDuration: 15000,
  },
  verification: {
    rules: [
      {
        id: 'trigger-activated',
        type: 'llm',
        description: 'Keyword trigger should activate',
        config: {
          successCriteria: 'Agent responds to help keyword trigger',
          dynamicallyGenerated: true,
        },
      },
      {
        id: 'adaptive-behavior',
        type: 'llm',
        description: 'Agent shows adaptive behavior',
        config: {
          successCriteria: 'Agent adapts responses based on user needs',
        },
      },
    ],
  },
};

// Export all scenarios
export const testFrameworkScenarios = [
  basicMessageExchangeScenario,
  actionExecutionScenario,
  multiActorComplexScenario,
  errorHandlingScenario,
  performanceBenchmarkScenario,
  securityTestScenario,
  dynamicVerificationScenario,
];

export default testFrameworkScenarios; 