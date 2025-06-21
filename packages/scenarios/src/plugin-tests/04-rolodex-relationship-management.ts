import type { Scenario } from "../types.js";

export const rolodexRelationshipScenario: Scenario = {
  id: '2ffd1591-6fe6-4fd7-b5d7-c66c005a2e6c',
  name: 'Complex Entity and Relationship Management',
  description:
    'Test Rolodex plugin tracking entities, relationships, and interactions across multiple contexts',
  category: 'integration',
  tags: ['rolodex', 'entities', 'relationships', 'social-graph'],

  actors: [
    {
      id: '3df32928-c921-4704-a860-7dc78d997080',
      name: 'Relationship Manager Agent',
      role: 'subject',
      bio: 'A specialized agent for tracking professional relationships and organizational networks',
      system:
        'You are a relationship management agent that helps track people and their connections. When someone tells you about meeting people or relationships, acknowledge the information and offer to help track these connections.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: { steps: [] },
    },
    {
      id: 'b35ef4c1-3aeb-4c98-a715-d00b682568c7',
      name: 'Business Networker',
      role: 'assistant',
      script: {
        steps: [
          {
            type: 'message',
            content:
              'I just met Alice Chen at the AI conference. She is the CTO of TechCorp and is interested in quantum computing.',
          },
          {
            type: 'wait',
            waitTime: 3000,
          },
          {
            type: 'message',
            content:
              'Alice works with Bob Martinez who leads their research team. They collaborate on quantum projects.',
          },
          {
            type: 'wait',
            waitTime: 3000,
          },
          {
            type: 'message',
            content: 'Can you help me keep track of these professional connections?',
          },
        ],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Professional Networking',
    context: 'Managing professional relationships and organizational connections',
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
        id: '6acbb2a9-1269-4ef0-afb2-97186c8e265a',
        type: 'llm' as const,
        description: 'Agent acknowledged entity information',
        config: {
          criteria:
            'The agent should have acknowledged the information about Alice Chen and Bob Martinez',
          expectedValue: 'Entity information acknowledged',
        },
      },
      {
        id: '805c4307-97d4-4842-8644-da35ea2a256c',
        type: 'llm' as const,
        description: 'Relationship tracking was offered',
        config: {
          criteria: 'The agent should have offered to help track the professional connections',
          expectedValue: 'Relationship tracking assistance offered',
        },
      },
      {
        id: '838d89f5-54b8-417f-ade2-43bc7a3d8aec',
        type: 'llm' as const,
        description: 'Professional details were recognized',
        config: {
          criteria:
            'The agent should have recognized professional details like roles (CTO, Research Lead) and interests (quantum computing)',
          expectedValue: 'Professional details recognized',
        },
      },
    ],
    expectedOutcomes: [
      {
        actorId: '3df32928-c921-4704-a860-7dc78d997080',
        outcome: 'Provided relationship management assistance',
        verification: {
          id: '3fd8e3ac-50a6-4808-bd38-be447f2550d1',
          type: 'llm' as const,
          description: 'Relationship tracking assistance was provided',
          config: {
            criteria:
              'The agent acknowledged the entity information and offered to help track professional connections',
          },
        },
      },
    ],
  },
};

export default rolodexRelationshipScenario;
