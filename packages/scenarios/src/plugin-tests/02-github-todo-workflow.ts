import type { Scenario } from "../types.js";

export const githubTodoWorkflowScenario: Scenario = {
  id: '6617ea8c-5156-4cd7-96bf-9017d20727c0',
  name: 'GitHub Issue to Todo Task Management',
  description:
    'Test GitHub plugin fetching issues and creating corresponding todos with proper tracking and completion',
  category: 'integration',
  tags: ['github', 'todo', 'project-management', 'action-chaining'],

  actors: [
    {
      id: '4880ef5d-03c8-4952-98fd-f3409df64b1a',
      name: 'Project Manager Agent',
      role: 'subject',
      bio: 'An efficient project management assistant',
      system:
        'You are a project manager who helps developers track GitHub issues and manage tasks efficiently. When asked about issues or tasks, provide helpful responses and use available tools when appropriate.',
      plugins: ['@elizaos/plugin-github', '@elizaos/plugin-todo'],
      script: { steps: [] },
    },
    {
      id: 'de52b6f0-d31b-48a4-bce9-712bf17b2ac2',
      name: 'Software Developer',
      role: 'assistant',
      script: {
        steps: [
          {
            type: 'message',
            content: 'Hi! Can you help me track some tasks for our project?',
          },
          {
            type: 'wait',
            waitTime: 3000,
          },
          {
            type: 'message',
            content: 'Can you create a todo for fixing the authentication bug we discussed?',
          },
          {
            type: 'wait',
            waitTime: 3000,
          },
          {
            type: 'message',
            content: 'Please list all current todos so I can see what we have',
          },
        ],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Project Management',
    context: 'Software development project tracking and task management',
  },

  execution: {
    maxDuration: 60000, // 1 minute
    maxSteps: 15,
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
        id: '8f7e9d0c-1a2b-3c4d-5e6f-7a8b9c0d1e2f',
        type: 'llm' as const,
        description: 'Agent responded to project help request',
        config: {
          criteria:
            'The agent should have responded helpfully to the request for project task tracking',
          expectedValue: 'Helpful response about project management',
        },
      },
      {
        id: '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d',
        type: 'llm' as const,
        description: 'Todo creation was handled',
        config: {
          criteria:
            'The agent should have acknowledged the todo creation request and either created a todo or explained the process',
          expectedValue: 'Todo creation response',
        },
      },
      {
        id: '2b3c4d5e-6f7a-8b9c-0d1e-2f3a4b5c6d7e',
        type: 'llm' as const,
        description: 'Todo listing was provided',
        config: {
          criteria:
            'The agent should have provided information about current todos or explained how to view them',
          expectedValue: 'Todo list information',
        },
      },
    ],
    expectedOutcomes: [
      {
        actorId: '4880ef5d-03c8-4952-98fd-f3409df64b1a',
        outcome: 'Assisted with project task management',
        verification: {
          id: '7a8b9c0d-1e2f-3a4b-5c6d-7e8f9a0b1c2d',
          type: 'llm' as const,
          description: 'Project management assistance was provided',
          config: {
            criteria:
              'The agent provided helpful responses about task tracking and todo management',
          },
        },
      },
    ],
  },
};

export default githubTodoWorkflowScenario;
