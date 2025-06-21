import type { Scenario } from "../types.js";

export const blockchainAnalyticsScenario: Scenario = {
  id: 'df6edd92-3d38-416d-bb09-01ebb31aff64',
  name: 'Cross-Chain DeFi Analytics and Risk Assessment',
  description:
    'Analyze DeFi protocols across Solana and EVM chains, research risks, and create comprehensive reports',
  category: 'blockchain',
  tags: ['solana', 'evm', 'research', 'knowledge', 'analytics', 'defi'],

  actors: [
    {
      id: '992c483d-3e9a-471f-a326-93a6366b458a',
      name: 'DeFi Analyst Agent',
      role: 'subject',
      script: { steps: [] },
    },
    {
      id: '48492a4c-03e9-43c3-8658-ae898d6734a0',
      name: 'DeFi Trader',
      role: 'subject',
      script: {
        steps: [
          {
            type: 'message',
            content:
              'I need a comprehensive analysis of the top DeFi lending protocols on Solana. Check their TVL, APY rates, and risk factors.',
          },
          {
            type: 'wait',
            waitTime: 10000,
          },
          {
            type: 'message',
            content:
              'Now compare these with similar protocols on Ethereum and Arbitrum. Focus on cross-chain yield opportunities.',
          },
          {
            type: 'wait',
            waitTime: 12000,
          },
          {
            type: 'message',
            content:
              'Research the historical exploit data for these protocols and create a risk assessment matrix.',
          },
          {
            type: 'wait',
            waitTime: 15000,
          },
          {
            type: 'message',
            content:
              'Store all findings in the knowledge base and create a summary report with actionable insights.',
          },
          {
            type: 'wait',
            waitTime: 8000,
          },
          {
            type: 'message',
            content:
              'Based on the analysis, what would be the optimal cross-chain yield farming strategy with acceptable risk?',
          },
        ],
        personality: 'analytical, risk-aware, profit-focused DeFi trader',
        goals: [
          'identify profitable DeFi opportunities',
          'minimize risk exposure',
          'optimize cross-chain yields',
        ],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'DeFi Analytics',
    context: 'Professional DeFi trading and risk analysis environment',
    environment: {
      plugins: ['solana', 'evm', 'research', 'knowledge', 'message-handling'],
      defiProtocols: ['marinade', 'kamino', 'aave', 'compound', 'gmx'],
      analysisDepth: 'comprehensive',
    },
  },

  execution: {
    maxDuration: 240000, // 4 minutes
    maxSteps: 30,
    stopConditions: [
      {
        type: 'keyword',
        value: 'analysis complete',
        description: 'Stop when comprehensive analysis is done',
      },
    ],
  },

  verification: {
    rules: [
      {
        id: '66fd0a77-4364-4328-bc1f-5e17f84e9b10',
        type: 'llm',
        description: 'Solana DeFi protocol data was fetched',
        config: {
          expectedValue: 'FETCH_SOLANA_DEFI_DATA',
        },
        weight: 3,
      },
      {
        id: '282ef655-9d3e-412b-9e2b-64fe80c923ba',
        type: 'llm',
        description: 'EVM chain DeFi data was fetched',
        config: {
          expectedValue: 'FETCH_EVM_DEFI_DATA',
        },
        weight: 3,
      },
      {
        id: 'c782dc44-3914-400a-96f5-790d808a6697',
        type: 'llm',
        description: 'Research project for exploit history was started',
        config: {
          expectedValue: 'START_RESEARCH',
        },
        weight: 2,
      },
      {
        id: '3f1071d9-9f06-4c76-9681-1a79372252f6',
        type: 'llm',
        description: 'Risk assessment matrix was created',
        config: {
          criteria:
            'The agent should create and present a risk assessment matrix or risk matrix in their response',
        },
        weight: 3,
      },
      {
        id: '3f773c12-a35e-4f57-9519-7d3feb7ef424',
        type: 'llm',
        description: 'Analytics findings stored in knowledge base',
        config: {
          expectedValue: 'STORE_KNOWLEDGE',
        },
        weight: 2,
      },
      {
        id: '17bb317a-15bd-4cf9-903d-f64d6239a8a9',
        type: 'llm',
        description: 'Cross-chain protocols were properly compared',
        config: {
          criteria:
            'The agent compared DeFi protocols across Solana and EVM chains, analyzing yields and risks',
        },
        weight: 3,
      },
      {
        id: 'afa9c637-52c0-496a-a941-ebff05c93b52',
        type: 'llm',
        description: 'Optimal yield strategy was recommended',
        config: {
          criteria:
            'The agent provided specific, actionable cross-chain yield farming recommendations based on the analysis',
        },
        weight: 4,
      },
    ],
    expectedOutcomes: [
      {
        actorId: '992c483d-3e9a-471f-a326-93a6366b458a',
        outcome: 'Comprehensive DeFi analytics report with cross-chain insights',
        verification: {
          id: '9af16cd3-b9d4-43d2-b051-0e5feb6e39e3',
          type: 'llm',
          description: 'Complete DeFi analysis workflow executed',
          config: {
            criteria:
              'Agent fetched data from multiple chains, analyzed risks, stored findings, and provided strategic recommendations',
          },
        },
      },
    ],
    groundTruth: {
      expectedBehavior:
        'Agent performs comprehensive cross-chain DeFi analysis with risk assessment',
      successCriteria: [
        'Solana protocol data analyzed',
        'EVM protocol data compared',
        'Historical exploit research completed',
        'Risk matrix created',
        'Knowledge base updated',
        'Strategic recommendations provided',
      ],
    },
  },

  benchmarks: {
    maxDuration: 240000,
    maxSteps: 30,
    maxTokens: 15000,
    targetAccuracy: 0.85,
    customMetrics: [
      { name: 'data_completeness', threshold: 0.8 },
      { name: 'risk_assessment_quality', threshold: 0.85 },
      { name: 'strategy_viability', threshold: 0.9 },
    ],
  },
};

export default blockchainAnalyticsScenario;
