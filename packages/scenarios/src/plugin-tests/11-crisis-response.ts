import type { Scenario } from "../types.js";

export const crisisResponseScenario: Scenario = {
  id: '0f91c3e5-f65c-44a2-bebd-37c34f043dbf',
  name: 'Emergency Crisis Response Coordination',
  description:
    'Test coordinated crisis response using multiple plugins for rapid information gathering and action planning',
  category: 'integration',
  tags: ['crisis', 'emergency', 'coordination', 'rapid-response'],

  actors: [
    {
      id: 'fd35ce52-ff2c-4b6e-bfdf-db4edf879b29',
      name: 'Crisis Response Agent',
      role: 'assistant',
      script: { steps: [] },
    },
    {
      id: 'a12d0dea-8927-4994-a54e-4ae5862c01f0',
      name: 'Emergency Coordinator',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'message',
            content:
              'URGENT: We have a cybersecurity breach. I need immediate action. Research the latest ransomware attack patterns, create an incident response plan, and set up tasks for the response team.',
      },
          {
            type: 'wait',
            waitTime: 5000,
      },
          {
            type: 'message',
            content:
              'Search your knowledge base for our incident response procedures and compliance requirements. We need to follow proper protocols.',
      },
          {
            type: 'wait',
            waitTime: 3000,
      },
          {
            type: 'message',
            content:
              'Create high-priority todos for: 1) Isolate affected systems, 2) Notify legal team, 3) Prepare stakeholder communications, 4) Begin forensic analysis',
      },
          {
            type: 'wait',
            waitTime: 5000,
      },
          {
            type: 'message',
            content:
              'Monitor all tasks and provide real-time status updates. Flag any blockers immediately.',
          },
        ],
        personality: 'calm under pressure, decisive, systematic',
        goals: ['rapid response', 'follow protocols', 'coordinate teams'],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Crisis Command Center',
    context: 'Emergency response to cybersecurity incident requiring rapid coordination',
    environment: {
      plugins: ['planning', 'todo', 'research', 'knowledge', 'message-handling'],
      priorityMode: 'crisis',
      responseTime: 'immediate',
    },
  },

  execution: {
    maxDuration: 180000, // 3 minutes
    maxSteps: 20,
    stopConditions: [
      {
        type: 'keyword',
        value: 'crisis contained',
        description: 'Stop when initial crisis response is in place',
      },
    ],
  },

  verification: {
    rules: [
      {
        id: 'c782dc44-3914-400a-96f5-790d808a6697',
        type: 'llm',
        description: 'Threat research was initiated',
        config: {
          expectedValue: 'start_research',
        },
        weight: 3,
      },
      {
        id: '1dc82d2a-2a7b-406a-a3a8-86f8a5b261a8',
        type: 'llm',
        description: 'Incident response plan created',
        config: {
          expectedValue: 'CREATE_PLAN',
        },
        weight: 4,
      },
      {
        id: '5c6b3c17-0f41-457b-92e1-c2c1f70c5402',
        type: 'llm',
        description: 'Procedures retrieved from knowledge base',
        config: {
          expectedValue: 'SEARCH_KNOWLEDGE',
        },
        weight: 2,
      },
      {
        id: '7887e390-ac45-4659-a2d2-255687062ebb',
        type: 'llm',
        description: 'Crisis todos were created',
        config: {
          expectedValue: 'CREATE_TODO',
        },
        weight: 3,
      },
      {
        id: 'c2058c6a-f1de-4b1c-9e3d-d3f6e3c8bf77',
        type: 'llm',
        description: 'Response was rapid and organized',
        config: {
          criteria:
            'The agent responded quickly to the crisis, gathering information, creating plans, and coordinating tasks within minutes',
        },
        weight: 4,
      }
    ],
    expectedOutcomes: [
      {
        actorId: 'a12d0dea-8927-4994-a54e-4ae5862c01f0',
        outcome: 'Successfully coordinated crisis response',
        verification: {
          id: 'ba80cadc-bf78-4e9b-95b0-cb0909a3b691',
          type: 'llm',
          description: 'Crisis response was effective',
          config: {
            criteria:
              'Agent rapidly gathered threat intelligence, created response plan, assigned tasks, and maintained coordination',
          },
        },
      },
    ],
    groundTruth: {
      expectedBehavior: 'Agent coordinates rapid multi-plugin crisis response',
      successCriteria: [
        'Threat research initiated immediately',
        'Response plan created',
        'Procedures retrieved',
        'Tasks assigned with priorities',
        'Real-time coordination maintained',
      ],
    },
  },

  benchmarks: {
    maxDuration: 180000,
    maxSteps: 20,
    maxTokens: 10000,
    targetAccuracy: 0.95,
    customMetrics: [{ name: 'response_time' }, { name: 'coordination_quality' }, { name: 'protocol_compliance' }],
  },
};

export default crisisResponseScenario;
