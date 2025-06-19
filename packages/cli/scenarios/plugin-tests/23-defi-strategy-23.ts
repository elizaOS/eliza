import type { Scenario } from '../../src/scenario-runner/types.js';

export const defistrategy23Scenario: Scenario = {
  id: 'c7ba377b-f85f-466e-97f7-aa0a434e3d5f',
  name: 'DeFi Strategy Optimization 23',
  description: 'Optimize DeFi strategies across chains',
  category: 'integration',
  tags: ['solana', 'evm', 'research', 'planning', 'complex-workflow'],
  
  actors: [
    {
      id: 'e710424e-d6f3-426b-b1e8-43e45b10cb72',
      name: 'Integration Agent',
      role: 'subject',
      script: { steps: [] },
    },
    {
      id: '2f06a248-c330-41d4-a58f-9e3dfd4b2b69',
      name: 'Test User',
      role: 'tester',
      script: {
        steps: [
          {
            type: 'message',
            content: 'Analyze yield opportunities in protocol 23 across different chains.',
      },
          {
            type: 'wait',
            waitTime: 8000,
      },
          {
            type: 'message',
            content: 'Research historical performance and risk metrics.',
      },
          {
            type: 'wait',
            waitTime: 10000,
      },
          {
            type: 'message',
            content: 'Create an optimal allocation strategy.',
      },
          {
            type: 'wait',
            waitTime: 12000,
      },
          {
            type: 'message',
            content: 'Plan the execution sequence for maximum efficiency.',
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
    context: 'Optimize DeFi strategies across chains',
    environment: {
      plugins: ['solana', 'evm', 'research', 'planning'],
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
          criteria: 'The agent successfully used solana, evm, research, planning plugins to complete the workflow',
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
        actorId: '2f06a248-c330-41d4-a58f-9e3dfd4b2b69',
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

export default defistrategy23Scenario;