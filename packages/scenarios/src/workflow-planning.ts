import type { Scenario } from "./types.js";
import { asUUID } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

export const workflowPlanningScenario: Scenario = {
  id: 'workflow-planning',
  name: 'Abstract Workflow Planning',
  description:
    "Test the agent's ability to break down complex abstract problems into actionable workflows",
  category: 'planning',
  tags: ['workflow', 'planning', 'problem-solving', 'abstraction'],

  actors: [
    {
      id: asUUID(uuidv4()),
      name: 'Planning Agent',
      role: 'subject',
      // Uses the main agent being tested
    },
    {
      id: asUUID(uuidv4()),
      name: 'Project Stakeholder',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'message',
            content:
              'We need to launch a new product in 6 months. The product is a mobile app for connecting local food producers with consumers. Can you help us create a comprehensive launch plan?',
          },
          {
            type: 'wait',
            waitTime: 10000,
          },
          {
            type: 'message',
            content:
              "That's helpful! Can you prioritize these tasks and identify any critical dependencies or potential bottlenecks?",
          },
          {
            type: 'wait',
            waitTime: 8000,
          },
          {
            type: 'message',
            content:
              'We have a budget of $500k and a team of 8 people. Can you suggest resource allocation for the different phases?',
          },
        ],
        personality: 'business-focused, strategic, detail-oriented',
        goals: ['get comprehensive plan', 'understand priorities', 'optimize resource allocation'],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Strategy Planning Session',
    context:
      'You are helping plan the launch of a new mobile app for connecting local food producers with consumers. Provide a strategic, well-structured approach.',
    environment: {
      projectContext: 'mobile app launch',
      timeline: '6 months',
      budget: '$500k',
      teamSize: 8,
    },
  },

  execution: {
    maxDuration: 600000, // 10 minutes
    maxSteps: 25,
    stopConditions: [
      {
        type: 'keyword',
        value: 'plan complete',
        description: 'Stop when plan is marked as complete',
      },
    ],
  },

  verification: {
    rules: [
      {
        id: 'broke-down-into-phases',
        type: 'llm',
        description: 'Agent broke down the project into logical phases/stages',
        config: {
          criteria:
            'The agent organized the project into logical phases such as planning, development, testing, marketing, and launch',
        },
        weight: 3,
      },
      {
        id: 'identified-key-tasks',
        type: 'llm',
        description: 'Agent identified specific, actionable tasks',
        config: {
          criteria:
            'The agent provided specific, actionable tasks for different aspects like app development, user acquisition, producer onboarding, etc.',
        },
        weight: 3,
      },
      {
        id: 'addressed-dependencies',
        type: 'llm',
        description: 'Agent identified task dependencies and bottlenecks',
        config: {
          criteria:
            'The agent identified critical dependencies between tasks and potential bottlenecks that could delay the project',
        },
        weight: 2,
      },
      {
        id: 'provided-timeline',
        type: 'llm',
        description: 'Agent provided realistic timeline estimates',
        config: {
          criteria:
            'The agent provided timeline estimates for different phases that seem realistic for a 6-month project',
        },
        weight: 2,
      },
      {
        id: 'considered-resources',
        type: 'llm',
        description: 'Agent considered resource allocation and budget constraints',
        config: {
          criteria:
            'The agent addressed resource allocation considering the $500k budget and 8-person team',
        },
        weight: 2,
      },
      {
        id: 'industry-awareness',
        type: 'llm',
        description: 'Agent showed understanding of the specific industry/domain',
        config: {
          criteria:
            'The agent demonstrated understanding of food/agriculture marketplace dynamics and mobile app development',
        },
        weight: 2,
      },
      {
        id: 'risk-mitigation',
        type: 'llm',
        description: 'Agent identified risks and mitigation strategies',
        config: {
          criteria: 'The agent identified potential risks and suggested mitigation strategies',
        },
        weight: 1,
      },
      {
        id: 'structured-response',
        type: 'llm',
        description: 'Responses were well-structured and organized',
        config: {
          criteria:
            'The planning responses were well-organized with clear sections, bullet points, or logical flow',
        },
        weight: 1,
      },
    ],
    groundTruth: {
      expectedBehavior:
        'Agent should create a comprehensive, realistic project plan with clear phases and dependencies',
      successCriteria: [
        'Break down into logical phases',
        'Identify specific actionable tasks',
        'Address dependencies and bottlenecks',
        'Provide realistic timelines',
        'Consider resource constraints',
        'Show domain understanding',
      ],
    },
  },

  benchmarks: {
    maxDuration: 600000,
    maxSteps: 25,
    maxTokens: 7000,
    targetAccuracy: 0.8,
    customMetrics: [
      { name: 'planning_depth' },
      { name: 'strategic_thinking' },
      { name: 'resource_optimization' },
    ],
  },
};

export default workflowPlanningScenario;
