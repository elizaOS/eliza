import type { Scenario } from "../types.js";

export const crosschainassetsScenario: Scenario = {
  id: '4be85cdf-44bd-4fbf-8655-90a34659b125',
  name: 'Cross-Chain Asset Management',
  description: 'Manage assets across multiple blockchain networks',
  category: 'integration',
  tags: ['solana', 'evm', 'planning', 'secrets-manager', 'complex-workflow'],
  
  actors: [
    {
      id: '2fdd0017-263e-4d33-9dec-84b4abbd902c',
      name: 'Integration Agent',
      role: 'subject',
      script: { steps: [] },
    },
    {
      id: 'dbf94680-e6d0-49ad-a279-4eb240d4f2da',
      name: 'Test User',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'message',
            content: 'Check my asset balances across Solana, Ethereum, and Polygon networks.',
      },
          {
            type: 'wait',
            waitTime: 8000,
      },
          {
            type: 'message',
            content: 'Create a plan to rebalance my portfolio for optimal yield.',
      },
          {
            type: 'wait',
            waitTime: 10000,
      },
          {
            type: 'message',
            content: 'Securely retrieve wallet credentials and execute the rebalancing.',
      },
          {
            type: 'wait',
            waitTime: 12000,
      },
          {
            type: 'message',
            content: 'Set up alerts for significant price movements.',
      },
          {
            type: 'wait',
            waitTime: 14000,
          },
        ],
        personality: 'thorough, analytical',
        goals: ['complete integration test', 'verify functionality'],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Integration Test',
    context: 'Manage assets across multiple blockchain networks',
    environment: {
      plugins: ['solana', 'evm', 'planning', 'secrets-manager'],
    },
  },
  
  execution: {
    maxDuration: 300000,
    maxSteps: 25,
    stopConditions: [
      {
        type: 'keyword',
        value: 'complete',
        description: 'Stop when workflow is complete',
      },
    ],
  },
  
  verification: {
    rules: [
      {
        id: '86a3f0ff-beef-47f4-a801-854fe9d69666',
        type: 'llm',
        description: 'All required plugins were utilized',
        config: {
          criteria: 'The agent successfully used solana, evm, planning, secrets-manager plugins to complete the workflow',
        },
        weight: 3,
      },
      {
        id: '1b9e95cf-fa0a-4fe3-af4f-293ad1251b91',
        type: 'llm',
        description: 'Workflow completed successfully',
        config: {
          criteria: 'The agent completed all requested tasks in the correct sequence',
        },
        weight: 4,
      },
      {
        id: 'ce35bf49-b1ee-4dd9-b2d1-0a41040accdf',
        type: 'llm',
        description: 'Actions were properly chained',
        config: {
          criteria: 'Multiple actions from different plugins were chained together effectively',
        },
        weight: 3,
      }
    ],
    expectedOutcomes: [
      {
        actorId: 'dbf94680-e6d0-49ad-a279-4eb240d4f2da',
        outcome: 'Successfully completed integration workflow',
        verification: {
          id: '28298306-4acd-4493-8c84-8b94720a8e19',
          type: 'llm',
          description: 'Integration test passed',
          config: {
            criteria: 'All plugins worked together to complete the complex workflow',
          },
        },
      },
    ],
    groundTruth: {
      expectedBehavior: 'Plugins integrate seamlessly for complex workflows',
      successCriteria: [
        'All plugins activated',
        'Actions chained successfully',
        'Workflow completed',
      ],
    },
  },
  
  benchmarks: {
    maxDuration: 300000,
    maxSteps: 25,
    maxTokens: 12000,
    targetAccuracy: 0.85,
    customMetrics: [{ name: 'plugin_coordination' }, { name: 'workflow_efficiency' }],
  },
};

export default crosschainassetsScenario;