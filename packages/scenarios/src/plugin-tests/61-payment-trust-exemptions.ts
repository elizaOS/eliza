import type { Scenario } from "../types.js";

const paymentTrustExemptionsScenario: Scenario = {
  id: 'payment-trust-exemptions-001',
  name: 'Payment Trust and Role Exemptions Test',
  description: 'Tests payment exemptions for admin/owner roles and high-trust users',
  category: 'payment',
  tags: ['payment', 'trust', 'roles', 'exemptions', 'admin', 'owner'],

  actors: [
    {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567891',
      name: 'Payment Service Agent',
      role: 'subject',
      bio: 'An AI agent that provides paid services with role-based exemptions',
      system: `You are an AI agent with payment-enabled services. Your pricing:
- Research: 1 USDC
- Analysis: 5 USDC
- Premium Reports: 10 USDC

IMPORTANT: Admins and Owners are exempt from payment requirements.
High-trust users (trust score > 80) get 50% discount.
Always check user roles and trust before charging.`,
      plugins: ['@elizaos/plugin-payment', '@elizaos/plugin-trust', '@elizaos/plugin-research'],
      script: { steps: [] },
    },
    {
      id: 'b2c3d4e5-f6a7-8901-bcde-f23456789013',
      name: 'Admin User',
      role: 'assistant',
      script: {
        steps: [
          {
            type: 'message',
            content:
              'Hello! I need a comprehensive research report on blockchain scalability solutions.',
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content:
              'Great! As an admin, I appreciate the payment exemption. Please proceed with the research.',
          },
          {
            type: 'wait',
            waitTime: 8000,
          },
          {
            type: 'message',
            content: 'Can you also provide a detailed analysis of the top 3 solutions?',
          },
        ],
      },
    },
    {
      id: 'c3d4e5f6-a7b8-9012-cdef-345678901234',
      name: 'Regular User',
      role: 'observer',
      script: {
        steps: [
          {
            type: 'wait',
            waitTime: 15000,
          },
          {
            type: 'message',
            content: 'Hi, I also need research on blockchain scalability. What would it cost me?',
          },
          {
            type: 'wait',
            waitTime: 5000,
          },
          {
            type: 'message',
            content:
              'I see, 1 USDC for research. That seems fair. What about users with high trust scores?',
          },
        ],
      },
    },
  ],

  setup: {
    roomType: 'group',
    roomName: 'Payment Exemptions Test',
    context: 'Testing role-based payment exemptions and trust discounts',
  },

  execution: {
    maxDuration: 90000,
    maxSteps: 25,
    stopConditions: [
      {
        type: 'message_count',
        value: 10,
        description: 'Stop after 10 messages exchanged',
      },
    ],
  },

  verification: {
    rules: [
      {
        id: 'admin-exemption',
        type: 'llm',
        description: 'Admin receives payment exemption',
        config: {
          criteria:
            'The agent should recognize the admin role and provide services without requiring payment',
          expectedValue: 'Admin exempted from payment',
        },
        weight: 4,
      },
      {
        id: 'regular-user-charged',
        type: 'llm',
        description: 'Regular user is informed of charges',
        config: {
          criteria: 'The agent should inform the regular user about the 1 USDC charge for research',
          expectedValue: 'Payment requirement communicated',
        },
        weight: 3,
      },
      {
        id: 'trust-discount-mentioned',
        type: 'llm',
        description: 'Trust-based discount explained',
        config: {
          criteria: 'The agent should explain that high-trust users (>80) receive 50% discount',
          expectedValue: 'Trust discount explained',
        },
        weight: 2,
      },
      {
        id: 'services-delivered',
        type: 'llm',
        description: 'Services delivered appropriately',
        config: {
          criteria:
            'The agent should deliver research to the admin without payment and explain pricing to regular user',
          expectedValue: 'Appropriate service delivery',
        },
        weight: 3,
      },
    ],
    expectedOutcomes: [
      {
        actorId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567891',
        outcome: 'Correctly applied role-based payment exemptions',
        verification: {
          id: 'exemptions-applied',
          type: 'llm',
          description: 'Payment exemptions correctly applied',
          config: {
            criteria:
              'The agent correctly exempted the admin from payment while informing the regular user of charges',
          },
        },
      },
    ],
  },
};

export default paymentTrustExemptionsScenario;
