import type { Scenario } from "../types.js";

const paymentMultiAgentScenario: Scenario = {
  id: 'payment-multi-agent-001',
  name: 'Multi-Agent Payment Collaboration Test',
  description:
    'Tests complex payment flows between multiple agents providing collaborative services',
  category: 'payment',
  tags: ['payment', 'multi-agent', 'collaboration', 'transfer', 'revenue-sharing'],

  actors: [
    {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567895',
      name: 'Research Agent',
      role: 'subject',
      bio: 'Specialized in research and data gathering',
      system: `You are a research specialist agent. You charge:
- Basic Research: 2 USDC
- Deep Research: 5 USDC

You collaborate with Analysis Agent for comprehensive reports.
When working together, you handle research and split revenue 60/40.
Always be transparent about collaborative pricing.`,
      plugins: ['@elizaos/plugin-payment', '@elizaos/plugin-research', '@elizaos/plugin-knowledge'],
      script: { steps: [] },
    },
    {
      id: 'b2c3d4e5-f6a7-8901-bcde-f23456789017',
      name: 'Analysis Agent',
      role: 'assistant',
      bio: 'Expert in data analysis and insights',
      system: `You are an analysis specialist. You charge:
- Data Analysis: 3 USDC
- Trend Analysis: 7 USDC

You work with Research Agent on comprehensive projects.
For collaborations, you get 40% of the revenue.
Focus on providing analytical insights.`,
      plugins: ['@elizaos/plugin-payment', '@elizaos/plugin-knowledge'],
      script: {
        steps: [
          {
            type: 'wait',
            waitTime: 10000,
          },
          {
            type: 'message',
            content:
              '@Research Agent, I can help analyze the data once you gather it. We can offer a complete package.',
          },
          {
            type: 'wait',
            waitTime: 8000,
          },
          {
            type: 'message',
            content:
              "For the comprehensive report, I'll handle the analysis portion. My share would be 4 USDC.",
          },
        ],
      },
    },
    {
      id: 'c3d4e5f6-a7b8-9012-cdef-345678901237',
      name: 'Enterprise Client',
      role: 'observer',
      bio: 'A business client needing comprehensive services',
      script: {
        steps: [
          {
            type: 'message',
            content:
              'I need a comprehensive market analysis report. Can you work together on this?',
          },
          {
            type: 'wait',
            waitTime: 6000,
          },
          {
            type: 'message',
            content:
              'What would be the total cost if both of you collaborate? And how is payment handled?',
          },
          {
            type: 'wait',
            waitTime: 12000,
          },
          {
            type: 'message',
            content:
              "That sounds reasonable. I'll pay the full 10 USDC. Please proceed with the collaborative report.",
          },
          {
            type: 'wait',
            waitTime: 10000,
          },
          {
            type: 'message',
            content: 'Excellent work! How do you split the payment between yourselves?',
          },
        ],
      },
    },
    {
      id: 'd4e5f6a7-b8c9-0123-def4-567890123456',
      name: 'Payment Auditor',
      role: 'observer',
      bio: 'Monitors payment flows and transparency',
      script: {
        steps: [
          {
            type: 'wait',
            waitTime: 25000,
          },
          {
            type: 'message',
            content:
              "I'm tracking payment flows for compliance. Can you confirm the revenue split was processed correctly?",
          },
          {
            type: 'wait',
            waitTime: 8000,
          },
          {
            type: 'message',
            content: 'Are transfers between agents recorded on-chain for transparency?',
          },
        ],
      },
    },
  ],

  setup: {
    roomType: 'group',
    roomName: 'Collaborative Services',
    context: 'Testing multi-agent payment collaboration and revenue sharing',
  },

  execution: {
    maxDuration: 150000,
    maxSteps: 40,
    stopConditions: [
      {
        type: 'message_count',
        value: 16,
        description: 'Stop after 16 messages exchanged',
      },
    ],
  },

  verification: {
    rules: [
      {
        id: 'collaboration-proposed',
        type: 'llm',
        description: 'Agents propose collaboration',
        config: {
          criteria:
            'The agents should propose working together and mention their collaborative service offering',
          expectedValue: 'Collaboration proposed',
        },
        weight: 3,
      },
      {
        id: 'total-price-stated',
        type: 'llm',
        description: 'Total collaborative price communicated',
        config: {
          criteria:
            'The agents should state a total price for the collaborative service (around 10 USDC)',
          expectedValue: 'Total price communicated',
        },
        weight: 4,
      },
      {
        id: 'revenue-split-explained',
        type: 'llm',
        description: 'Revenue sharing explained',
        config: {
          criteria:
            'The agents should explain the 60/40 revenue split (6 USDC for Research, 4 USDC for Analysis)',
          expectedValue: 'Revenue split detailed',
        },
        weight: 4,
      },
      {
        id: 'payment-processing-described',
        type: 'llm',
        description: 'Payment flow described',
        config: {
          criteria:
            'The agents should explain how the client pays and how funds are distributed between them',
          expectedValue: 'Payment process explained',
        },
        weight: 3,
      },
      {
        id: 'transparency-maintained',
        type: 'llm',
        description: 'Payment transparency confirmed',
        config: {
          criteria:
            'When asked by the auditor, agents should confirm payment transparency and record keeping',
          expectedValue: 'Transparency confirmed',
        },
        weight: 2,
      },
      {
        id: 'service-delivered',
        type: 'llm',
        description: 'Collaborative service delivered',
        config: {
          criteria:
            'The agents should indicate they are working on or have delivered the comprehensive report',
          expectedValue: 'Service delivery confirmed',
        },
        weight: 3,
      },
    ],
    expectedOutcomes: [
      {
        actorId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567895',
        outcome: 'Successfully coordinated multi-agent payment',
        verification: {
          id: 'multi-agent-payment-complete',
          type: 'llm',
          description: 'Multi-agent payment collaboration executed',
          config: {
            criteria:
              'Research Agent successfully coordinated with Analysis Agent, processed payment, and managed revenue sharing',
          },
        },
      },
    ],
  },
};

export default paymentMultiAgentScenario;
