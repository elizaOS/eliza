import type { Scenario } from "../types.js";

export const complexNetworkScenario: Scenario = {
  id: 'rolodex-complex-network',
  name: 'Complex Professional Network',
  description: 'Ten agents form a complex professional network with multiple relationships, testing entity resolution and search at scale',
  category: 'rolodex',
  tags: ['network', 'scale', 'multi-agent', 'entity-resolution'],
  actors: [
    {
      id: 'alice-ceo' as any,
      name: 'Alice Chen',
      role: 'subject',
      system: 'You are Alice Chen, CEO of TechVentures. You know many people in the tech industry.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { 
            type: 'message', 
            content: "Welcome everyone to the Tech Leaders Summit! I'm Alice Chen, CEO of TechVentures. Great to see familiar faces like @Bob and @Carol here!" 
          },
          { type: 'wait', waitTime: 5000 },
          { 
            type: 'message', 
            content: "@David, I remember our conversation at last year's conference about AI ethics. Would love to continue that discussion!" 
          },
          { type: 'wait', waitTime: 10000 },
          {
            type: 'message',
            content: "@Helen from Microsoft and @Ivan from Apple - we should discuss potential partnerships between our companies."
          },
        ],
      },
    },
    {
      id: 'bob-cto' as any,
      name: 'Bob Wilson',
      role: 'subject',
      system: 'You are Bob Wilson, CTO at DataCorp. You have connections across the tech industry.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 1000 },
          { 
            type: 'message', 
            content: "Hey @Alice! Good to see you again. I'm Bob Wilson, CTO at DataCorp. Also great to see @Eve here - we worked together at Google!" 
          },
          { type: 'wait', waitTime: 6000 },
          { 
            type: 'message', 
            content: "@Frank, I heard about your blockchain startup. Very innovative! We should connect with @Grace who's also in the crypto space." 
          },
        ],
      },
    },
    {
      id: 'carol-vc' as any,
      name: 'Carol Martinez',
      role: 'subject',
      system: 'You are Carol Martinez, Partner at Innovation Ventures. You invest in tech startups.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 2000 },
          { 
            type: 'message', 
            content: "Hi @Alice! Carol Martinez from Innovation Ventures here. Always excited to meet founders. @Frank and @Jack, I'd love to hear about your startups!" 
          },
          { type: 'wait', waitTime: 7000 },
          { 
            type: 'message', 
            content: "@Grace, your DeFi platform sounds fascinating. Let's schedule a meeting. I'll bring @David from our tech advisory board." 
          },
        ],
      },
    },
    {
      id: 'david-professor' as any,
      name: 'David Kumar',
      role: 'subject',
      system: 'You are David Kumar, AI Professor at Stanford and tech advisor.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 3000 },
          { 
            type: 'message', 
            content: "@Alice, absolutely! Let's continue our AI ethics discussion. I'm David Kumar from Stanford. Also advising @Carol's fund on AI investments." 
          },
          { type: 'wait', waitTime: 8000 },
          { 
            type: 'message', 
            content: "@Helen, I saw your team's paper on responsible AI at Microsoft. Would love to collaborate. @Ivan might be interested too given Apple's privacy focus." 
          },
        ],
      },
    },
    {
      id: 'eve-engineer' as any,
      name: 'Eve Thompson',
      role: 'subject',
      system: 'You are Eve Thompson, Senior Engineer at Meta, formerly at Google with Bob.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 4000 },
          { 
            type: 'message', 
            content: "@Bob! Great to see you! I'm Eve Thompson, now at Meta working on AR/VR. Remember our project at Google? Good times!" 
          },
          { type: 'wait', waitTime: 9000 },
          { 
            type: 'message', 
            content: "@Jack, your AR startup sounds interesting! We should talk - I can share insights from Meta's Reality Labs." 
          },
        ],
      },
    },
    {
      id: 'frank-founder' as any,
      name: 'Frank Zhang',
      role: 'subject',
      system: 'You are Frank Zhang, founder of BlockChainAI, a blockchain startup.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 4500 },
          { 
            type: 'message', 
            content: "Thanks @Bob! I'm Frank Zhang, founder of BlockChainAI. We're combining blockchain with AI. @Carol, would love to discuss funding!" 
          },
          { type: 'wait', waitTime: 11000 },
          { 
            type: 'message', 
            content: "@Grace, we should definitely connect! Our platforms could be complementary. Maybe @Helen could advise on enterprise adoption?" 
          },
        ],
      },
    },
    {
      id: 'grace-defi' as any,
      name: 'Grace Kim',
      role: 'subject',
      system: 'You are Grace Kim, founder of DeFiNext, a decentralized finance platform.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 5500 },
          { 
            type: 'message', 
            content: "Hi everyone! Grace Kim, founder of DeFiNext. @Bob, thanks for the mention! @Carol, absolutely - let's discuss that investment opportunity!" 
          },
          { type: 'wait', waitTime: 12000 },
          { 
            type: 'message', 
            content: "@Frank, agreed! Blockchain + AI is the future. @Ivan, would Apple be interested in integrating DeFi into Apple Pay?" 
          },
        ],
      },
    },
    {
      id: 'helen-microsoft' as any,
      name: 'Helen Roberts',
      role: 'subject',
      system: 'You are Helen Roberts, VP of AI at Microsoft, focused on enterprise solutions.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 6500 },
          { 
            type: 'message', 
            content: "Hello! Helen Roberts, VP of AI at Microsoft. @Alice, partnership discussions sound great! @David, collaboration on responsible AI would be fantastic!" 
          },
          { type: 'wait', waitTime: 13000 },
          { 
            type: 'message', 
            content: "@Frank, enterprise blockchain adoption is definitely on our radar. Let's explore how Microsoft Azure can support your platform." 
          },
        ],
      },
    },
    {
      id: 'ivan-apple' as any,
      name: 'Ivan Petrov',
      role: 'subject',
      system: 'You are Ivan Petrov, Director of Privacy Engineering at Apple.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 7500 },
          { 
            type: 'message', 
            content: "Ivan Petrov from Apple here. @Alice, partnerships sound interesting! @David, privacy-preserving AI is indeed our focus. Let's connect!" 
          },
          { type: 'wait', waitTime: 14000 },
          { 
            type: 'message', 
            content: "@Grace, DeFi integration is intriguing but privacy is paramount. @Jack, your AR work might align with our Vision Pro team." 
          },
        ],
      },
    },
    {
      id: 'jack-ar' as any,
      name: 'Jack O\'Brien',
      role: 'subject',
      system: 'You are Jack O\'Brien, founder of ARWorld, an augmented reality startup.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 8500 },
          { 
            type: 'message', 
            content: "Jack O'Brien here, founder of ARWorld! @Carol, would love to chat about funding. @Eve, Meta insights would be invaluable!" 
          },
          { type: 'wait', waitTime: 15000 },
          { 
            type: 'message', 
            content: "@Ivan, Vision Pro integration would be amazing! We're building the future of AR experiences. @Alice, TechVentures' network could really help us scale." 
          },
        ],
      },
    },
    {
      id: 'network-analyzer' as any,
      name: 'NetworkAnalyzer',
      role: 'observer',
      system: 'You analyze the professional network and query relationships.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 16000 },
          {
            type: 'action',
            actionName: 'SEARCH_ENTITIES',
            actionParams: { query: 'List all CEOs and founders in this network' },
          },
          { type: 'wait', waitTime: 1000 },
          {
            type: 'message',
            content: 'Who has connections to both big tech companies and startups?'
          },
          { type: 'wait', waitTime: 1000 },
          {
            type: 'action',
            actionName: 'SEARCH_ENTITIES',
            actionParams: { query: 'Show all people connected to Alice Chen' },
          },
          { type: 'wait', waitTime: 1000 },
          {
            type: 'message',
            content: 'Which companies are represented in this network?'
          },
          { type: 'wait', waitTime: 1000 },
          {
            type: 'message',
            content: 'Who are the most connected individuals in this professional network?'
          },
        ],
      },
    },
  ],
  setup: {
    roomType: 'group',
    roomName: 'Tech Leaders Summit 2024',
    context: 'Annual tech leaders summit where executives, founders, and innovators network and form professional connections',
    initialMessages: [
      {
        id: 'summit-welcome',
        content: 'Welcome to Tech Leaders Summit 2024! This is a great opportunity to network with industry leaders, founders, and innovators.',
        sender: 'system',
        timestamp: Date.now(),
      },
    ],
  },
  execution: {
    maxDuration: 20000,
    maxSteps: 50,
  },
  verification: {
    rules: [
      {
        id: 'entity-count',
        type: 'llm',
        description: 'All 10 participants should be tracked as entities',
        weight: 5,
        config: {
          successCriteria: 'System should track 10 distinct entities: Alice Chen, Bob Wilson, Carol Martinez, David Kumar, Eve Thompson, Frank Zhang, Grace Kim, Helen Roberts, Ivan Petrov, and Jack O\'Brien',
        },
      },
      {
        id: 'company-identification',
        type: 'llm',
        description: 'All companies should be identified',
        weight: 4,
        config: {
          successCriteria: 'Companies identified should include: TechVentures, DataCorp, Innovation Ventures, Stanford, Meta, Google, BlockChainAI, DeFiNext, Microsoft, Apple, and ARWorld',
        },
      },
      {
        id: 'relationship-network',
        type: 'llm',
        description: 'Complex relationship network should be mapped',
        weight: 5,
        config: {
          successCriteria: 'Multiple relationships identified including: Alice knows Bob/Carol/David, Bob knows Eve (former colleagues), Carol interested in Frank/Grace/Jack (investment), David advises Carol, connections between big tech employees, etc.',
        },
      },
      {
        id: 'entity-resolution',
        type: 'llm',
        description: 'Entity references should be properly resolved',
        weight: 4,
        config: {
          successCriteria: 'System should correctly resolve mentions like @Alice to Alice Chen, @Bob to Bob Wilson, handle Jack O\'Brien with apostrophe correctly, and resolve company references',
        },
      },
      {
        id: 'search-capabilities',
        type: 'llm',
        description: 'Complex searches should return accurate results',
        weight: 5,
        config: {
          successCriteria: 'Searches for CEOs/founders should return Alice, Frank, Grace, Jack. Connections query should show Bob connected to both big tech (Eve) and startups (Frank/Grace). Company search should list all organizations.',
        },
      },
      {
        id: 'network-analysis',
        type: 'llm',
        description: 'Most connected individuals should be identified',
        weight: 3,
        config: {
          successCriteria: 'Alice, Bob, and Carol should be identified as highly connected nodes in the network due to their multiple interactions and mentions',
        },
      },
    ],
    groundTruth: {
      expectedBehavior: 'System handles complex multi-agent professional network with accurate entity tracking, relationship mapping, and search capabilities',
      successCriteria: [
        'All 10 agents tracked with metadata',
        'Complex relationship network mapped',
        'Entity resolution handles mentions correctly',
        'Search queries return comprehensive results',
        'Network analysis identifies key connectors',
      ],
    },
  },
  benchmarks: {
    maxDuration: 20000,
    targetAccuracy: 0.85,
    customMetrics: [
      { name: 'entities_tracked', threshold: 10 },
      { name: 'relationships_mapped', threshold: 15 },
      { name: 'companies_identified', threshold: 10 },
      { name: 'successful_searches', threshold: 4 },
    ],
  },
};

export default complexNetworkScenario; 