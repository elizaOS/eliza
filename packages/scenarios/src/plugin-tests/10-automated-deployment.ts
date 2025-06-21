import type { Scenario } from "../types.js";

export const automatedDeploymentScenario: Scenario = {
  id: 'f1a2b3c4-d5e6-7f8a-9b0c-1d2e3f4a5b6c',
  name: 'Automated CI/CD Deployment Pipeline',
  description: 'Test automated deployment workflow using GitHub, planning, and deployment plugins',
  category: 'integration',
  tags: ['deployment', 'cicd', 'automation', 'devops'],

  actors: [
    {
      id: 'a2b3c4d5-e6f7-8a9b-0c1d-2e3f4a5b6c7d',
      name: 'DevOps Agent',
      role: 'subject',
      bio: 'A DevOps automation agent that manages CI/CD pipelines and deployments',
      system:
        'You are a DevOps agent that helps with deployment planning and CI/CD best practices. When asked about deployments, provide helpful guidance on the deployment process.',
      plugins: ['@elizaos/plugin-github', '@elizaos/plugin-planning', '@elizaos/plugin-todo'],
      script: { steps: [] },
    },
    {
      id: 'b3c4d5e6-f7a8-9b0c-1d2e-3f4a5b6c7d8e',
      name: 'Release Manager',
      role: 'assistant',
      script: {
        steps: [
          {
            type: 'message',
            content:
              'Hi! I need help planning a deployment for our application. What should I consider?',
          },
          {
            type: 'wait',
            waitTime: 4000,
          },
          {
            type: 'message',
            content: 'What are the key steps in a deployment checklist?',
          },
          {
            type: 'wait',
            waitTime: 4000,
          },
          {
            type: 'message',
            content: 'How should I handle rollback procedures if something goes wrong?',
          },
        ],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Release Management',
    context: 'Managing automated deployment pipeline for production release',
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
        id: 'c4d5e6f7-a8b9-0c1d-2e3f-4a5b6c7d8e9f',
        type: 'llm' as const,
        description: 'Deployment planning guidance was provided',
        config: {
          criteria:
            'The agent should have provided guidance on what to consider when planning a deployment',
          expectedValue: 'Deployment planning guidance',
        },
      },
      {
        id: 'd5e6f7a8-b9c0-1d2e-3f4a-5b6c7d8e9f0a',
        type: 'llm' as const,
        description: 'Deployment checklist was explained',
        config: {
          criteria: 'The agent should have explained key steps in a deployment checklist',
          expectedValue: 'Deployment checklist explained',
        },
      },
      {
        id: 'e6f7a8b9-c0d1-2e3f-4a5b-6c7d8e9f0a1b',
        type: 'llm' as const,
        description: 'Rollback procedures were covered',
        config: {
          criteria: 'The agent should have explained how to handle rollback procedures',
          expectedValue: 'Rollback procedures explained',
        },
      },
    ],
    expectedOutcomes: [
      {
        actorId: 'a2b3c4d5-e6f7-8a9b-0c1d-2e3f4a5b6c7d',
        outcome: 'Provided deployment guidance and best practices',
        verification: {
          id: 'd1e2f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f6a',
          type: 'llm' as const,
          description: 'Deployment assistance was provided',
          config: {
            criteria:
              'The agent provided helpful guidance on deployment planning, checklists, and rollback procedures',
          },
        },
      },
    ],
  },
};

export default automatedDeploymentScenario;
