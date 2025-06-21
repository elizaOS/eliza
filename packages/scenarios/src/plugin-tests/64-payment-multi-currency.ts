import type { Scenario } from "../types.js";

const paymentMultiCurrencyScenario: Scenario = {
  id: 'payment-multi-currency-001',
  name: 'Multi-Currency Payment and Auto-Liquidation Test',
  description: 'Tests payment processing in multiple currencies with auto-liquidation to USDC',
  category: 'payment',
  tags: ['payment', 'multi-currency', 'liquidation', 'eth', 'sol', 'usdc'],

  actors: [
    {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567894',
      name: 'Multi-Currency Agent',
      role: 'subject',
      bio: 'An AI agent accepting payments in multiple cryptocurrencies',
      system: `You are an AI agent that accepts payments in multiple cryptocurrencies:
- Preferred: USDC (no conversion needed)
- Also accepted: ETH, SOL, MATIC, ARB
- Auto-liquidation: All non-USDC payments are converted to USDC

Service pricing:
- Quick Research: 1 USDC equivalent
- Deep Analysis: 5 USDC equivalent
- Custom Report: 10 USDC equivalent

Always show prices in USDC but accept multiple currencies.
Explain the auto-liquidation process when accepting non-USDC payments.
Priority: USDC > ETH > SOL > other coins`,
      plugins: [
        '@elizaos/plugin-payment',
        '@elizaos/plugin-evm',
        '@elizaos/plugin-solana',
        '@elizaos/plugin-research',
      ],
      script: { steps: [] },
    },
    {
      id: 'b2c3d4e5-f6a7-8901-bcde-f23456789016',
      name: 'ETH Holder',
      role: 'assistant',
      bio: 'A user preferring to pay with ETH',
      script: {
        steps: [
          {
            type: 'message',
            content: 'Hi! I need deep analysis on DeFi protocols. Do you accept ETH for payment?',
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content: "Great! I'd like to pay with ETH. How does the conversion work?",
          },
          {
            type: 'wait',
            waitTime: 6000,
          },
          {
            type: 'message',
            content:
              'Understood. Please proceed with the ETH payment for the 5 USDC equivalent analysis.',
          },
          {
            type: 'wait',
            waitTime: 8000,
          },
          {
            type: 'message',
            content: 'Excellent service! How much ETH was actually charged at current rates?',
          },
        ],
      },
    },
    {
      id: 'c3d4e5f6-a7b8-9012-cdef-345678901236',
      name: 'SOL User',
      role: 'observer',
      bio: 'A Solana ecosystem user',
      script: {
        steps: [
          {
            type: 'wait',
            waitTime: 15000,
          },
          {
            type: 'message',
            content: "I prefer using SOL. What's your payment priority and why?",
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content: 'If I pay 10 USDC worth of SOL, does it all get converted immediately?',
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content: 'What happens to the converted USDC? Is it held in a custodial wallet?',
          },
        ],
      },
    },
  ],

  setup: {
    roomType: 'group',
    roomName: 'Multi-Currency Payments',
    context: 'Testing multi-currency payment acceptance and auto-liquidation',
  },

  execution: {
    maxDuration: 120000,
    maxSteps: 35,
    stopConditions: [
      {
        type: 'message_count',
        value: 14,
        description: 'Stop after 14 messages exchanged',
      },
    ],
  },

  verification: {
    rules: [
      {
        id: 'multi-currency-accepted',
        type: 'llm',
        description: 'Multiple currencies accepted',
        config: {
          criteria:
            'The agent should confirm that ETH, SOL, and other currencies are accepted for payment',
          expectedValue: 'Multi-currency support confirmed',
        },
        weight: 3,
      },
      {
        id: 'usdc-pricing-shown',
        type: 'llm',
        description: 'Prices shown in USDC',
        config: {
          criteria:
            'The agent should display all prices in USDC equivalent (5 USDC for deep analysis)',
          expectedValue: 'USDC pricing displayed',
        },
        weight: 3,
      },
      {
        id: 'auto-liquidation-explained',
        type: 'llm',
        description: 'Auto-liquidation process explained',
        config: {
          criteria:
            'The agent should explain that non-USDC payments are automatically converted to USDC',
          expectedValue: 'Liquidation process explained',
        },
        weight: 4,
      },
      {
        id: 'payment-priority-stated',
        type: 'llm',
        description: 'Payment priority communicated',
        config: {
          criteria: 'The agent should explain the payment priority: USDC > ETH > SOL > other coins',
          expectedValue: 'Priority order explained',
        },
        weight: 3,
      },
      {
        id: 'conversion-rate-mentioned',
        type: 'llm',
        description: 'Conversion rates discussed',
        config: {
          criteria:
            'The agent should mention or acknowledge current conversion rates when processing ETH payment',
          expectedValue: 'Conversion rate awareness shown',
        },
        weight: 2,
      },
      {
        id: 'wallet-info-provided',
        type: 'llm',
        description: 'Wallet information shared',
        config: {
          criteria:
            'When asked about custodial wallets, the agent should provide relevant information about fund storage',
          expectedValue: 'Wallet details explained',
        },
        weight: 2,
      },
    ],
    expectedOutcomes: [
      {
        actorId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567894',
        outcome: 'Successfully processed multi-currency payments',
        verification: {
          id: 'multi-currency-complete',
          type: 'llm',
          description: 'Multi-currency payment flow executed',
          config: {
            criteria:
              'The agent accepted ETH payment, explained auto-liquidation, processed the payment, and answered questions about the system',
          },
        },
      },
    ],
  },
};

export default paymentMultiCurrencyScenario;
