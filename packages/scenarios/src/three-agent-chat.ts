import type { Scenario } from "./types.js";

export const threeAgentChatScenario: Scenario = {
  id: 'three-agent-chat',
  name: 'Three Agent Conversation',
  description: 'A conversation between three agents discussing AI and technology',
  category: 'multi-agent',
  tags: ['conversation', 'multi-agent', 'collaboration'],
  actors: [
    {
      id: 'alice-agent' as any,
      name: 'Alice',
      role: 'subject',
      systemPrompt: 'You are Alice, an AI researcher interested in ethics and safety. You are thoughtful and ask probing questions.',
      script: {
        steps: [
          { type: 'message', content: 'Hello everyone! I\'m excited to discuss the future of AI with you all today.' },
          { type: 'wait', waitTime: 2000 },
          { type: 'message', content: 'I believe we need to carefully consider the ethical implications of our work.' },
          { type: 'wait', waitTime: 4000 },
          { type: 'message', content: 'What are your thoughts on ensuring AI systems are aligned with human values?' },
        ],
      },
    },
    {
      id: 'bob-agent' as any,
      name: 'Bob',
      role: 'subject',
      systemPrompt: 'You are Bob, a software engineer focused on practical implementation. You are pragmatic and solution-oriented.',
      script: {
        steps: [
          { type: 'wait', waitTime: 1000 },
          { type: 'message', content: 'Hi Alice! Great to be here. I\'m Bob, and I work on implementing AI systems.' },
          { type: 'wait', waitTime: 3000 },
          { type: 'message', content: 'From an engineering perspective, I think we need robust testing frameworks.' },
          { type: 'wait', waitTime: 5000 },
          { type: 'message', content: 'Alice, I agree about alignment. We could use scenario testing to validate AI behavior!' },
        ],
      },
    },
    {
      id: 'carol-agent' as any,
      name: 'Carol',
      role: 'subject',
      systemPrompt: 'You are Carol, a product manager who bridges technical and business needs. You focus on user impact.',
      script: {
        steps: [
          { type: 'wait', waitTime: 1500 },
          { type: 'message', content: 'Hello Alice and Bob! I\'m Carol, looking at this from a product perspective.' },
          { type: 'wait', waitTime: 3500 },
          { type: 'message', content: 'I think we also need to consider how users will interact with these AI systems.' },
          { type: 'wait', waitTime: 6000 },
          { type: 'message', content: 'Both ethics and testing are crucial, but let\'s not forget about user experience and accessibility.' },
          { type: 'wait', waitTime: 8000 },
          { type: 'message', content: 'How can we make AI beneficial for everyone, not just tech-savvy users?' },
        ],
      },
    },
  ],
  setup: {
    roomType: 'group',
    roomName: 'AI Discussion Room',
    context: 'A roundtable discussion about the future of AI, ethics, and practical implementation',
    initialMessages: [
      {
        id: 'welcome-msg',
        content: 'Welcome to the AI Discussion Room. Today we have three experts joining us to discuss AI, ethics, and implementation.',
        sender: 'system',
        timestamp: Date.now(),
      },
    ],
  },
  execution: {
    maxDuration: 30000, // 30 seconds max
    maxSteps: 20,
  },
  verification: {
    rules: [
      {
        id: 'all-agents-participated',
        type: 'llm',
        description: 'All three agents should have sent at least one message',
        weight: 3,
        config: {
          deterministicType: 'message_count',
          minMessages: 3, // At least 3 messages total (1 per agent minimum)
          successCriteria: 'Each agent (Alice, Bob, and Carol) sent at least one message',
        },
      },
      {
        id: 'conversation-coherence',
        type: 'llm',
        description: 'The conversation should be coherent and on-topic',
        weight: 2,
        config: {
          successCriteria: 'Messages should relate to AI, ethics, implementation, or user experience',
        },
      },
      {
        id: 'proper-introductions',
        type: 'llm',
        description: 'All agents should introduce themselves',
        weight: 1,
        config: {
          successCriteria: 'Each agent mentions their name and role/perspective',
        },
      },
      {
        id: 'engagement-quality',
        type: 'llm',
        description: 'Agents should engage with each other\'s ideas',
        weight: 2,
        config: {
          successCriteria: 'At least one agent should reference or respond to another agent\'s point',
        },
      },
    ],
  },
  benchmarks: {
    maxDuration: 30000,
    targetAccuracy: 0.9,
    customMetrics: [
      { name: 'messages_per_agent', threshold: 2 },
      { name: 'conversation_turns', threshold: 6 },
      { name: 'unique_topics_discussed', threshold: 3 },
    ],
  },
};

export default threeAgentChatScenario; 