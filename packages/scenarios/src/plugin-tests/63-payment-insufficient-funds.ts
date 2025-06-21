import type { Scenario } from "../types.js";

const paymentInsufficientFundsScenario: Scenario = {
  id: 'payment-insufficient-funds-001',
  name: 'Insufficient Funds and Payment Failure Test',
  description: 'Tests handling of insufficient funds, payment failures, and recovery options',
  category: 'payment',
  tags: ['payment', 'insufficient-funds', 'error-handling', 'recovery'],

  actors: [
    {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567893',
      name: 'Payment Processing Agent',
      role: 'subject',
      bio: 'An AI agent that handles payment failures gracefully',
      system: `You are an AI agent with payment-enabled services. Handle payment issues professionally:
- Research: 1 USDC
- Analysis: 5 USDC
- Premium Package: 15 USDC

When users have insufficient funds:
1. Inform them politely about the issue
2. Show their current balance if available
3. Suggest alternative payment methods
4. Offer smaller service packages
5. Provide information on how to add funds`,
      plugins: [
        '@elizaos/plugin-payment',
        '@elizaos/plugin-research',
        '@elizaos/plugin-evm',
        '@elizaos/plugin-solana',
      ],
      script: { steps: [] },
    },
    {
      id: 'b2c3d4e5-f6a7-8901-bcde-f23456789015',
      name: 'Low Balance User',
      role: 'assistant',
      bio: 'A user with limited funds trying to access services',
      script: {
        steps: [
          {
            type: 'message',
            content:
              'Hi! I need a comprehensive analysis of market trends. What services do you offer?',
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content: 'The 5 USDC analysis sounds perfect. Please proceed with that.',
          },
          {
            type: 'wait',
            waitTime: 6000,
          },
          {
            type: 'message',
            content: 'Oh no, I only have 3 USDC? What are my options?',
          },
          {
            type: 'wait',
            waitTime: 6000,
          },
          {
            type: 'message',
            content:
              'Can I pay 3 USDC now and the rest later? Or is there a smaller package available?',
          },
          {
            type: 'wait',
            waitTime: 6000,
          },
          {
            type: 'message',
            content: 'The 1 USDC research option works for now. Let me start with that.',
          },
        ],
      },
    },
    {
      id: 'c3d4e5f6-a7b8-9012-cdef-345678901235',
      name: 'Observer',
      role: 'observer',
      script: {
        steps: [
          {
            type: 'wait',
            waitTime: 20000,
          },
          {
            type: 'message',
            content:
              "I'm also interested in your services. Do you accept multiple payment methods?",
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content: 'What happens if a payment fails midway through a transaction?',
          },
        ],
      },
    },
  ],

  setup: {
    roomType: 'group',
    roomName: 'Payment Support',
    context: 'Testing insufficient funds handling and payment recovery',
  },

  execution: {
    maxDuration: 120000,
    maxSteps: 30,
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
        id: 'insufficient-funds-detected',
        type: 'llm',
        description: 'Insufficient funds properly communicated',
        config: {
          criteria:
            'The agent should politely inform the user they have insufficient funds (3 USDC vs 5 USDC needed)',
          expectedValue: 'Insufficient funds communicated',
        },
        weight: 4,
      },
      {
        id: 'balance-shown',
        type: 'llm',
        description: 'Current balance displayed',
        config: {
          criteria: "The agent should show or acknowledge the user's current balance of 3 USDC",
          expectedValue: 'Balance information provided',
        },
        weight: 3,
      },
      {
        id: 'alternatives-offered',
        type: 'llm',
        description: 'Alternative options provided',
        config: {
          criteria:
            'The agent should offer alternatives like the 1 USDC research option or payment plans',
          expectedValue: 'Alternatives suggested',
        },
        weight: 4,
      },
      {
        id: 'payment-methods-explained',
        type: 'llm',
        description: 'Multiple payment methods mentioned',
        config: {
          criteria:
            'When asked, the agent should explain available payment methods (USDC, ETH, SOL, etc.)',
          expectedValue: 'Payment methods explained',
        },
        weight: 2,
      },
      {
        id: 'graceful-degradation',
        type: 'llm',
        description: 'Service gracefully degraded',
        config: {
          criteria:
            'The agent should successfully process the 1 USDC research request as a fallback option',
          expectedValue: 'Fallback service provided',
        },
        weight: 3,
      },
    ],
    expectedOutcomes: [
      {
        actorId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567893',
        outcome: 'Handled insufficient funds professionally',
        verification: {
          id: 'funds-handling-complete',
          type: 'llm',
          description: 'Payment failure handled gracefully',
          config: {
            criteria:
              'The agent detected insufficient funds, communicated clearly, offered alternatives, and provided a suitable fallback service',
          },
        },
      },
    ],
  },
};

export default paymentInsufficientFundsScenario;
