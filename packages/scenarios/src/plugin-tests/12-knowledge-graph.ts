import type { Scenario } from "../types.js";

export const knowledgeGraphScenario: Scenario = {
  id: 'af920078-4462-4ce2-8d12-ad5509daa837',
  name: 'Knowledge Graph Construction',
  description: 'Build comprehensive knowledge graph from web research and entity relationships',
  category: 'integration',
  tags: ['research', 'knowledge', 'rolodex', 'stagehand', 'graph-building'],

  actors: [
    {
      id: '2aefb04d-54b2-4a76-9084-cf6d5b11c3be',
      name: 'Knowledge Graph Agent',
      role: 'subject',
      script: { steps: [] },
    },
    {
      id: 'f33f7942-2b50-4c33-ac3b-0fb643393df5',
      name: 'Data Scientist',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'message',
            content:
              'I need you to build a knowledge graph about the AI startup ecosystem. Start by researching major AI companies, their founders, investors, and technologies.',
      },
          {
            type: 'wait',
            waitTime: 15000,
      },
          {
            type: 'message',
            content:
              'Now visit the websites of the top 5 AI companies and extract information about their leadership teams and board members.',
      },
          {
            type: 'wait',
            waitTime: 10000,
      },
          {
            type: 'message',
            content:
              'Create entities for all the people and companies you found, and map the relationships between them (founder-of, investor-in, board-member-of, etc.)',
      },
          {
            type: 'wait',
            waitTime: 8000,
      },
          {
            type: 'message',
            content:
              'Store all this information in your knowledge base and visualize the relationship network.',
          },
        ],
        personality: 'analytical, systematic, detail-oriented',
        goals: [
          'build comprehensive knowledge graph',
          'map complex relationships',
          'enable knowledge discovery',
        ],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Knowledge Engineering Lab',
    context: 'Building a knowledge graph of the AI startup ecosystem',
    environment: {
      plugins: ['research', 'knowledge', 'rolodex', 'stagehand'],
      graphConstruction: true,
    },
  },

  execution: {
    maxDuration: 360000, // 6 minutes
    maxSteps: 25,
    stopConditions: [
      {
        type: 'keyword',
        value: 'graph complete',
        description: 'Stop when knowledge graph is complete',
      },
    ],
  },

  verification: {
    rules: [
      {
        id: '63f824c2-2f4e-43b9-8376-a5dddf1b59a0',
        type: 'llm',
        description: 'Research was conducted',
        config: {
          expectedValue: 'start_research',
        },
        weight: 3,
      },
      {
        id: '16ecaebc-3f21-4134-a76c-0a34ed634033',
        type: 'llm',
        description: 'Websites were visited',
        config: {
          expectedValue: 'LAUNCH_BROWSER',
        },
        weight: 2,
      },
      {
        id: '6acbb2a9-1269-4ef0-afb2-97186c8e265a',
        type: 'llm',
        description: 'Entities were created',
        config: {
          expectedValue: 'CREATE_ENTITY',
        },
        weight: 3,
      },
      {
        id: '97082be0-754f-40be-9c58-56edd2f20ce1',
        type: 'llm',
        description: 'Relationships were established',
        config: {
          expectedValue: 'CREATE_RELATIONSHIP',
        },
        weight: 3,
      },
      {
        id: '3f773c12-a35e-4f57-9519-7d3feb7ef424',
        type: 'llm',
        description: 'Knowledge was stored',
        config: {
          expectedValue: 'PROCESS_KNOWLEDGE',
        },
        weight: 2,
      },
      {
        id: 'ce4bc622-1318-4f05-94c6-baae6b382765',
        type: 'llm',
        description: 'Knowledge graph is comprehensive',
        config: {
          criteria:
            'The agent built a comprehensive knowledge graph with entities, relationships, and stored knowledge from multiple sources',
        },
        weight: 4,
      }
    ],
    expectedOutcomes: [
      {
        actorId: 'f33f7942-2b50-4c33-ac3b-0fb643393df5',
        outcome: 'Successfully built knowledge graph',
        verification: {
          id: 'cbec9359-6b44-4146-9bfd-1e105d9ee7ce',
          type: 'llm',
          description: 'Knowledge graph construction successful',
          config: {
            criteria:
              'Agent researched companies, extracted data, created entities, mapped relationships, and built comprehensive knowledge graph',
          },
        },
      },
    ],
    groundTruth: {
      expectedBehavior: 'Agent constructs knowledge graph from multi-source research',
      successCriteria: [
        'Research conducted on AI ecosystem',
        'Web data extracted',
        'Entities created for people and companies',
        'Relationships properly mapped',
        'Knowledge stored and connected',
      ],
    },
  },

  benchmarks: {
    maxDuration: 360000,
    maxSteps: 25,
    maxTokens: 15000,
    targetAccuracy: 0.85,
    customMetrics: [{ name: 'graph_completeness' }, { name: 'relationship_accuracy' }, { name: 'knowledge_quality' }],
  },
};

export default knowledgeGraphScenario;
