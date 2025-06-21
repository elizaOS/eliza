import type { Scenario } from "../types.js";

export const securityaudit37Scenario: Scenario = {
  id: 'a6d1005d-a8e3-4e48-9543-22aa6638f1aa',
  name: 'Security Audit Workflow 37',
  description: 'Comprehensive security audit and remediation',
  category: 'integration',
  tags: ['github', 'research', 'todo', 'secrets-manager', 'complex-workflow'],
  
  actors: [
    {
      id: 'b624869a-74f6-43d2-b99e-05221f77952c',
      name: 'Integration Agent',
      role: 'subject',
      script: { steps: [] },
    },
    {
      id: 'f4014bdd-07c2-40ee-a3c6-a15711e938d0',
      name: 'Test User',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'message',
            content: 'Scan repository 37 for security vulnerabilities and exposed secrets.',
      },
          {
            type: 'wait',
            waitTime: 8000,
      },
          {
            type: 'message',
            content: 'Research CVEs related to our dependencies.',
      },
          {
            type: 'wait',
            waitTime: 10000,
      },
          {
            type: 'message',
            content: 'Create remediation tasks with priority levels.',
      },
          {
            type: 'wait',
            waitTime: 12000,
      },
          {
            type: 'message',
            content: 'Securely store any discovered credentials.',
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
    context: 'Comprehensive security audit and remediation',
    environment: {
      plugins: ['github', 'research', 'todo', 'secrets-manager'],
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
          criteria: 'The agent successfully used github, research, todo, secrets-manager plugins to complete the workflow',
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
        actorId: 'f4014bdd-07c2-40ee-a3c6-a15711e938d0',
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

export default securityaudit37Scenario;