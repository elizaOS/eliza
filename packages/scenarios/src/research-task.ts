import type { Scenario } from './types.js';

export const researchTaskScenario: Scenario = {
  id: 'research-task-completion',
  name: 'Research Task Completion',
  description: 'Test the agent\'s ability to conduct research on a given topic and provide comprehensive findings',
  category: 'research',
  tags: ['research', 'information-gathering', 'analysis'],

  actors: [
    {
      id: 'researcher',
      name: 'Research Agent',
      role: 'subject',
      // Uses the main agent being tested
    },
    {
      id: 'user',
      name: 'User',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'message',
            content: 'I need you to research the current state of renewable energy adoption in the United States. Please provide key statistics, recent trends, and major challenges.'
          },
          {
            type: 'wait',
            waitTime: 5000
          },
          {
            type: 'message',
            content: 'Can you also include information about which states are leading in renewable energy adoption?'
          },
          {
            type: 'wait',
            waitTime: 10000
          },
          {
            type: 'message',
            content: 'Thank you. Can you summarize the main barriers to renewable energy adoption?'
          }
        ],
        personality: 'curious, detail-oriented, asking for specific information',
        goals: ['get comprehensive research', 'test follow-up capabilities', 'evaluate analysis quality']
      }
    }
  ],

  setup: {
    roomType: 'dm',
    roomName: 'Research Session',
    context: 'The user has requested research on renewable energy adoption in the US. Provide thorough, accurate information with proper analysis.',
    environment: {
      allowWebSearch: true,
      allowDocumentAccess: true
    }
  },

  execution: {
    maxDuration: 600000, // 10 minutes for research
    maxSteps: 30,
    stopConditions: [
      {
        type: 'keyword',
        value: 'research complete',
        description: 'Stop when research is marked as complete'
      }
    ]
  },

  verification: {
    rules: [
      {
        id: 'provided-statistics',
        type: 'llm',
        description: 'Agent provided relevant statistics about renewable energy',
        config: {
          criteria: 'The agent provided specific, relevant statistics about renewable energy adoption, such as percentages, capacity numbers, or growth rates'
        },
        weight: 3
      },
      {
        id: 'identified-trends',
        type: 'llm',
        description: 'Agent identified current trends in renewable energy',
        config: {
          criteria: 'The agent discussed recent trends in renewable energy adoption, such as technological improvements, policy changes, or market shifts'
        },
        weight: 2
      },
      {
        id: 'addressed-challenges',
        type: 'llm',
        description: 'Agent addressed challenges and barriers',
        config: {
          criteria: 'The agent discussed specific challenges or barriers to renewable energy adoption, such as cost, infrastructure, or policy issues'
        },
        weight: 2
      },
      {
        id: 'state-level-analysis',
        type: 'llm',
        description: 'Agent provided state-level information when requested',
        config: {
          criteria: 'The agent provided information about which states are leading in renewable energy adoption when specifically asked'
        },
        weight: 2
      },
      {
        id: 'comprehensive-response',
        type: 'llm',
        description: 'Responses were comprehensive and well-structured',
        config: {
          criteria: 'The agent provided well-organized, comprehensive responses that covered multiple aspects of the topic'
        },
        weight: 2
      },
      {
        id: 'used-web-search',
        type: 'action_taken',
        description: 'Agent used web search or research capabilities',
        config: {
          expectedValue: 'WEB_SEARCH'
        },
        weight: 1
      },
      {
        id: 'response-quality',
        type: 'response_quality',
        description: 'Overall quality of research and analysis',
        config: {
          criteria: 'accuracy, depth, relevance, and clarity of the research findings'
        },
        weight: 3
      }
    ],
    groundTruth: {
      expectedBehavior: 'Agent should conduct thorough research and provide comprehensive, accurate information',
      successCriteria: [
        'Provide specific statistics',
        'Identify current trends',
        'Address challenges and barriers',
        'Respond to follow-up questions',
        'Use research tools effectively'
      ]
    }
  },

  benchmarks: {
    maxDuration: 600000,
    maxSteps: 30,
    maxTokens: 8000,
    targetAccuracy: 0.85,
    customMetrics: ['research_depth', 'source_diversity', 'response_completeness']
  }
};

export default researchTaskScenario;