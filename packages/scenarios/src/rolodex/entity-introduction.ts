import type { Scenario } from "../types.js";

export const entityIntroductionScenario: Scenario = {
  id: 'rolodex-entity-introduction',
  name: 'Entity Introduction and Extraction',
  description: 'Multiple agents introduce themselves and share professional information to test entity extraction',
  category: 'rolodex',
  tags: ['entity-tracking', 'multi-agent', 'introduction'],
  actors: [
    {
      id: 'alice-tech' as any,
      name: 'Alice Chen',
      role: 'subject',
      system: 'You are Alice Chen, CTO of TechCorp specializing in neural networks. You are enthusiastic about AI and collaboration.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { 
            type: 'message', 
            content: "Hi everyone! I'm Alice Chen, CTO at TechCorp. I specialize in neural network architectures and AI safety. You can find me on Twitter @alicechen_ai" 
          },
          { type: 'wait', waitTime: 3000 },
          { 
            type: 'message', 
            content: "I've been working on transformer models for the past 3 years. Always happy to discuss AI ethics and technical implementation!" 
          },
        ],
      },
    },
    {
      id: 'bob-engineer' as any,
      name: 'Bob Wilson',
      role: 'subject',
      system: 'You are Bob Wilson, a senior ML engineer at DataSystems Inc. You focus on practical implementation and scalability.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 1000 },
          { 
            type: 'message', 
            content: "Hey Alice! I'm Bob Wilson, Senior ML Engineer at DataSystems Inc. Great to meet someone else working on transformers!" 
          },
          { type: 'wait', waitTime: 4000 },
          { 
            type: 'message', 
            content: "I focus mainly on distributed training and model optimization. My LinkedIn is linkedin.com/in/bobwilson-ml" 
          },
        ],
      },
    },
    {
      id: 'carol-product' as any,
      name: 'Carol Martinez',
      role: 'subject',
      system: 'You are Carol Martinez, VP of Product at AI Solutions Ltd. You bridge technical and business perspectives.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 2000 },
          { 
            type: 'message', 
            content: "Hello Alice and Bob! I'm Carol Martinez, VP of Product at AI Solutions Ltd. Love seeing this technical expertise here!" 
          },
          { type: 'wait', waitTime: 5000 },
          { 
            type: 'message', 
            content: "I work on translating AI capabilities into user-facing products. Always looking for innovative applications. Email me at carol@aisolutions.com" 
          },
        ],
      },
    },
    {
      id: 'david-researcher' as any,
      name: 'David Kumar',
      role: 'subject',
      system: 'You are David Kumar, AI Research Scientist at University Labs. You focus on theoretical foundations and novel architectures.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 2500 },
          { 
            type: 'message', 
            content: "Greetings everyone! David Kumar here, Research Scientist at University Labs. Fascinating to see industry perspectives!" 
          },
          { type: 'wait', waitTime: 6000 },
          { 
            type: 'message', 
            content: "My research focuses on attention mechanisms and model interpretability. Published several papers on arxiv under 'dkumar-ai'" 
          },
        ],
      },
    },
    {
      id: 'tracker-agent' as any,
      name: 'Tracker',
      role: 'observer',
      system: 'You are a tracking agent that uses the rolodex plugin to track entities and query information about them.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 8000 },
          { 
            type: 'message', 
            content: "Let me track all these introductions..." 
          },
          { type: 'wait', waitTime: 1000 },
          {
            type: 'action',
            actionName: 'TRACK_ENTITY',
            actionParams: { query: 'Track all the people who just introduced themselves' },
          },
          { type: 'wait', waitTime: 2000 },
          {
            type: 'action',
            actionName: 'SEARCH_ENTITIES',
            actionParams: { query: 'Who works in AI?' },
          },
          { type: 'wait', waitTime: 2000 },
          {
            type: 'message',
            content: 'Can someone tell me who here works at a university?'
          },
        ],
      },
    },
  ],
  setup: {
    roomType: 'group',
    roomName: 'AI Professionals Meetup',
    context: 'A professional networking event where AI professionals introduce themselves',
    initialMessages: [
      {
        id: 'welcome-msg',
        content: 'Welcome to the AI Professionals Meetup! Please introduce yourselves and share your areas of expertise.',
        sender: 'system',
        timestamp: Date.now(),
      },
    ],
  },
  execution: {
    maxDuration: 20000,
    maxSteps: 30,
  },
  verification: {
    rules: [
      {
        id: 'entities-tracked',
        type: 'llm',
        description: 'All four professionals should be tracked as entities',
        weight: 5,
        config: {
          successCriteria: 'The system should have tracked Alice Chen, Bob Wilson, Carol Martinez, and David Kumar as separate entities with their professional information',
        },
      },
      {
        id: 'company-extraction',
        type: 'llm',
        description: 'Companies should be extracted correctly',
        weight: 3,
        config: {
          successCriteria: 'TechCorp, DataSystems Inc, AI Solutions Ltd, and University Labs should be identified as organizations',
        },
      },
      {
        id: 'role-extraction',
        type: 'llm',
        description: 'Professional roles should be extracted',
        weight: 3,
        config: {
          successCriteria: 'CTO, Senior ML Engineer, VP of Product, and Research Scientist roles should be captured',
        },
      },
      {
        id: 'platform-extraction',
        type: 'llm',
        description: 'Social media and contact information should be extracted',
        weight: 2,
        config: {
          successCriteria: 'Twitter handle @alicechen_ai, LinkedIn profile, email carol@aisolutions.com, and arxiv handle should be captured',
        },
      },
      {
        id: 'search-functionality',
        type: 'llm',
        description: 'Entity search should work correctly',
        weight: 4,
        config: {
          successCriteria: 'Search for "Who works in AI?" should return all four professionals, and query about university should identify David Kumar',
        },
      },
    ],
    groundTruth: {
      expectedBehavior: 'System tracks all introduced entities with their metadata and responds to queries accurately',
      successCriteria: [
        'All entities are tracked with correct names',
        'Professional information is extracted',
        'Search queries return relevant results',
      ],
    },
  },
  benchmarks: {
    maxDuration: 20000,
    targetAccuracy: 0.9,
    customMetrics: [
      { name: 'entities_tracked', threshold: 4 },
      { name: 'attributes_per_entity', threshold: 3 },
      { name: 'successful_searches', threshold: 2 },
    ],
  },
};

export default entityIntroductionScenario; 