import type { Scenario } from "../types.js";

export const blockchainDefiWorkflowScenario: Scenario = {
  id: 'a9b0c1d2-e3f4-5a6b-7c8d-9e0f1a2b3c4d',
  name: 'Cross-Chain DeFi Operations',
  description: 'Test Solana and EVM plugins performing DeFi operations across multiple blockchains',
  category: 'integration',
  tags: ['blockchain', 'defi', 'solana', 'evm', 'cross-chain'],

  actors: [
    {
      id: 'b0c1d2e3-f4a5-6b7c-8d9e-0f1a2b3c4d5e',
      name: 'DeFi Agent',
      role: 'subject',
      bio: 'A blockchain agent specialized in DeFi operations across multiple chains',
      system:
        'You are a DeFi agent that helps with cryptocurrency and blockchain questions. When asked about DeFi operations, provide helpful information about how these systems work.',
      plugins: ['@elizaos/plugin-solana', '@elizaos/plugin-evm'],
      script: { steps: [] },
    },
    {
      id: 'c1d2e3f4-a5b6-7c8d-9e0f-1a2b3c4d5e6f',
      name: 'Crypto Trader',
      role: 'assistant',
      script: {
        steps: [
          {
            type: 'message',
            content:
              'Can you explain how DeFi works on different blockchains like Solana and Ethereum?',
          },
          {
            type: 'wait',
            waitTime: 4000,
          },
          {
            type: 'message',
            content: 'What are the main differences between trading on Solana vs Ethereum?',
          },
          {
            type: 'wait',
            waitTime: 4000,
          },
          {
            type: 'message',
            content: 'How do cross-chain bridges work for moving assets between chains?',
          },
        ],
      },
    },
  ],

  setup: {
    roomType: 'dm',
    roomName: 'DeFi Trading',
    context: 'Cross-chain DeFi operations and asset management',
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
        id: 'd2e3f4a5-b6c7-8d9e-0f1a-2b3c4d5e6f7a',
        type: 'llm' as const,
        description: 'DeFi explanation was provided',
        config: {
          criteria: 'The agent should have explained how DeFi works on different blockchains',
          expectedValue: 'DeFi explanation provided',
        },
      },
      {
        id: 'e3f4a5b6-c7d8-9e0f-1a2b-3c4d5e6f7a8b',
        type: 'llm' as const,
        description: 'Chain differences were explained',
        config: {
          criteria: 'The agent should have explained differences between Solana and Ethereum',
          expectedValue: 'Chain differences explained',
        },
      },
      {
        id: 'f4a5b6c7-d8e9-0f1a-2b3c-4d5e6f7a8b9c',
        type: 'llm' as const,
        description: 'Bridge functionality was explained',
        config: {
          criteria: 'The agent should have explained how cross-chain bridges work',
          expectedValue: 'Bridge explanation provided',
        },
      },
    ],
    expectedOutcomes: [
      {
        actorId: 'b0c1d2e3-f4a5-6b7c-8d9e-0f1a2b3c4d5e',
        outcome: 'Provided DeFi education and guidance',
        verification: {
          id: 'd8e9f0a1-b2c3-4d5e-6f7a-8b9c0d1e2f3a',
          type: 'llm' as const,
          description: 'DeFi education was provided',
          config: {
            criteria:
              'The agent provided helpful explanations about DeFi, blockchain differences, and cross-chain operations',
          },
        },
      },
    ],
  },
};

export default blockchainDefiWorkflowScenario;
