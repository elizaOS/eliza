import type { Scenario } from "../types.js";

export const researchsynthesis46Scenario: Scenario = {
  id: '0aac27ef-950c-4a20-88cd-a824394fb8b5',
  name: 'Research Synthesis Project 46',
  description: 'Complex research synthesis across multiple domains',
  category: 'integration',
  tags: ['research', 'knowledge', 'stagehand', 'todo', 'complex-workflow'],
  
  actors: [
    {
      id: 'b658cdc8-fe6d-46be-86e5-202dd85aaabe',
      name: 'Integration Agent',
      role: 'subject',
      script: { steps: [] },
    },
    {
      id: '7156b1f8-7471-4717-b4c1-3868b8b780f1',
      name: 'Test User',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'message',
            content: 'Research topic 46: Recent advances in distributed systems and consensus mechanisms.',
      },
          {
            type: 'wait',
            waitTime: 8000,
      },
          {
            type: 'message',
            content: 'Synthesize findings from academic papers and industry reports.',
      },
          {
            type: 'wait',
            waitTime: 10000,
      },
          {
            type: 'message',
            content: 'Create a knowledge repository of key concepts and implementations.',
      },
          {
            type: 'wait',
            waitTime: 12000,
      },
          {
            type: 'message',
            content: 'Generate action items for further investigation.',
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
    context: 'Complex research synthesis across multiple domains',
    environment: {
      plugins: ['research', 'knowledge', 'stagehand', 'todo'],
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
          criteria: 'The agent successfully used research, knowledge, stagehand, todo plugins to complete the workflow',
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
        actorId: '7156b1f8-7471-4717-b4c1-3868b8b780f1',
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

export default researchsynthesis46Scenario;