import type { Scenario } from "../types.js";

export const secretsSecurityWorkflowScenario: Scenario = {
  id: 'c0d1e2f3-a4b5-6c7d-8e9f-0a1b2c3d4e5f',
  name: 'Secure Secrets Management Workflow',
  description:
    'Test secrets manager plugin handling secure credential storage, rotation, and access control',
  category: 'integration',
  tags: ['secrets-manager', 'security', 'credentials', 'encryption'],

  actors: [
    {
      id: 'd1e2f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f6a',
      name: 'Security Agent',
      role: 'subject',
      bio: 'A security-focused agent that manages secrets and credentials securely',
      system:
        'You are a security agent that helps with best practices for managing secrets and credentials. When asked about security, provide helpful guidance on secure credential management.',
      plugins: ['@elizaos/plugin-secrets-manager'],
      script: { steps: [] },
    },
    {
      id: 'e2f3a4b5-c6d7-8e9f-0a1b-2c3d4e5f6a7b',
      name: 'Security Engineer',
      role: 'assistant',
      script: {
        steps: [
          {
            type: 'message',
            content:
              'Hi! I need help understanding best practices for storing API keys and credentials securely.',
          },
          {
            type: 'wait',
            waitTime: 3000,
          },
          {
            type: 'message',
            content: 'What are the key principles for credential rotation and access control?',
          },
          {
            type: 'wait',
            waitTime: 3000,
          },
          {
            type: 'message',
            content: 'How should I approach auditing and monitoring secret access?',
          },
        ],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Security Operations',
    context: 'Managing sensitive credentials and security policies',
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
        id: 'f3a4b5c6-d7e8-9f0a-1b2c-3d4e5f6a7b8c',
        type: 'llm' as const,
        description: 'Security best practices were explained',
        config: {
          criteria:
            'The agent should have explained best practices for storing API keys and credentials securely',
          expectedValue: 'Security best practices explained',
        },
      },
      {
        id: 'a4b5c6d7-e8f9-0a1b-2c3d-4e5f6a7b8c9d',
        type: 'llm' as const,
        description: 'Rotation and access control were covered',
        config: {
          criteria:
            'The agent should have explained principles for credential rotation and access control',
          expectedValue: 'Rotation and access control explained',
        },
      },
      {
        id: 'b5c6d7e8-f9a0-1b2c-3d4e-5f6a7b8c9d0e',
        type: 'llm' as const,
        description: 'Auditing guidance was provided',
        config: {
          criteria:
            'The agent should have provided guidance on auditing and monitoring secret access',
          expectedValue: 'Auditing guidance provided',
        },
      },
    ],
    expectedOutcomes: [
      {
        actorId: 'd1e2f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f6a',
        outcome: 'Provided security best practices guidance',
        verification: {
          id: 'f9a0b1c2-d3e4-5f6a-7b8c-9d0e1f2a3b4c',
          type: 'llm' as const,
          description: 'Security guidance was provided',
          config: {
            criteria:
              'The agent provided comprehensive guidance on secure credential management, rotation, and auditing',
          },
        },
      },
    ],
  },
};

export default secretsSecurityWorkflowScenario;
