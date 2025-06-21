import type { Scenario } from "../types.js";

export const relationshipBuildingScenario: Scenario = {
  id: 'rolodex-relationship-building',
  name: 'Relationship Building and Evolution',
  description: 'Multiple agents collaborate and build relationships over time to test relationship inference and strength',
  category: 'rolodex',
  tags: ['relationships', 'multi-agent', 'collaboration'],
  actors: [
    {
      id: 'alice-lead' as any,
      name: 'Alice Chen',
      role: 'subject',
      system: 'You are Alice Chen, project lead. You coordinate with team members and build collaborative relationships.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { 
            type: 'message', 
            content: "Hey team! I'm excited to work with all of you on this AI safety project. @Bob, I heard great things about your work on distributed systems." 
          },
          { type: 'wait', waitTime: 4000 },
          { 
            type: 'message', 
            content: "@Carol, your UX expertise will be crucial for making our safety tools accessible. Let's schedule a design review next week?" 
          },
          { type: 'wait', waitTime: 8000 },
          {
            type: 'message',
            content: "Great discussion everyone! @Bob, thanks for sharing those optimization insights. @David, your theoretical framework is exactly what we needed!"
          },
          { type: 'wait', waitTime: 12000 },
          {
            type: 'message',
            content: "@Eve, welcome to the team! I'll introduce you to everyone. You'll be working closely with @Bob on the infrastructure."
          },
        ],
      },
    },
    {
      id: 'bob-engineer' as any,
      name: 'Bob Wilson',
      role: 'subject',
      system: 'You are Bob Wilson, senior engineer. You collaborate with teammates and mentor new members.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 2000 },
          { 
            type: 'message', 
            content: "Thanks @Alice! I'm thrilled to be part of this project. @David, I'd love to discuss how we can implement your theoretical models efficiently." 
          },
          { type: 'wait', waitTime: 6000 },
          { 
            type: 'message', 
            content: "@Carol, I can help integrate the backend with your UI designs. We've done similar work at my previous company." 
          },
          { type: 'wait', waitTime: 10000 },
          {
            type: 'message',
            content: "Absolutely @Alice! Those optimizations should give us a 3x speedup. @David, your input was invaluable."
          },
          { type: 'wait', waitTime: 14000 },
          {
            type: 'message',
            content: "Welcome @Eve! Happy to mentor you on our infrastructure. Let's pair program tomorrow to get you up to speed."
          },
        ],
      },
    },
    {
      id: 'carol-designer' as any,
      name: 'Carol Martinez',
      role: 'subject',
      system: 'You are Carol Martinez, UX designer. You collaborate on making AI systems user-friendly.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 3000 },
          { 
            type: 'message', 
            content: "@Alice, I'd love to schedule that design review! @Bob, thanks for offering to help with the integration. Your backend expertise is much appreciated!" 
          },
          { type: 'wait', waitTime: 7000 },
          { 
            type: 'message', 
            content: "@David, I'm creating user flows based on your safety framework. Could we collaborate on making the concepts more intuitive for non-technical users?" 
          },
          { type: 'wait', waitTime: 15000 },
          {
            type: 'message',
            content: "Hi @Eve! Great to have another team member. I handle the UX side - let me know if you need any design assets for your work with @Bob."
          },
        ],
      },
    },
    {
      id: 'david-theorist' as any,
      name: 'David Kumar',
      role: 'subject',
      system: 'You are David Kumar, AI theorist. You provide theoretical foundations and collaborate on practical implementations.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 3500 },
          { 
            type: 'message', 
            content: "@Bob, yes! Let's definitely discuss implementation. I have some ideas on optimizing the attention mechanisms. @Alice, thanks for bringing us together!" 
          },
          { type: 'wait', waitTime: 7500 },
          { 
            type: 'message', 
            content: "@Carol, I'd be happy to help simplify the concepts! Your UX perspective is exactly what we need to make this accessible." 
          },
          { type: 'wait', waitTime: 11000 },
          {
            type: 'message',
            content: "This collaboration is fantastic! @Alice, your leadership is really bringing out the best in everyone. @Bob, those optimizations are brilliant!"
          },
        ],
      },
    },
    {
      id: 'eve-newcomer' as any,
      name: 'Eve Thompson',
      role: 'subject',
      system: 'You are Eve Thompson, a new junior engineer joining the team. You are eager to learn and contribute.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 13000 },
          { 
            type: 'message', 
            content: "Hello everyone! I'm Eve Thompson, just joined as a junior engineer. Excited to learn from all of you and contribute to this amazing project!" 
          },
          { type: 'wait', waitTime: 16000 },
          { 
            type: 'message', 
            content: "Thank you @Alice for the warm welcome! @Bob, I really appreciate the mentorship offer. Looking forward to our pair programming session!" 
          },
          { type: 'wait', waitTime: 17000 },
          {
            type: 'message',
            content: "@Carol, thanks! I'll definitely reach out if I need design assets. This team seems amazing - everyone is so collaborative!"
          },
        ],
      },
    },
    {
      id: 'relationship-tracker' as any,
      name: 'RelationshipTracker',
      role: 'observer',
      system: 'You are a relationship tracking agent that monitors and queries relationship information.',
      plugins: ['@elizaos/plugin-rolodex'],
      script: {
        steps: [
          { type: 'wait', waitTime: 18000 },
          {
            type: 'action',
            actionName: 'SEARCH_ENTITIES',
            actionParams: { query: 'Show all relationships between team members' },
          },
          { type: 'wait', waitTime: 1000 },
          {
            type: 'message',
            content: 'Who has the strongest collaborative relationships in this team?'
          },
          { type: 'wait', waitTime: 2000 },
          {
            type: 'message',
            content: 'What is the relationship between Bob and Eve?'
          },
        ],
      },
    },
  ],
  setup: {
    roomType: 'group',
    roomName: 'AI Safety Project Team',
    context: 'A project team collaborating on AI safety tools, building professional relationships over time',
    initialMessages: [
      {
        id: 'kickoff-msg',
        content: 'Welcome to the AI Safety Project team channel. This is where we collaborate and coordinate our work.',
        sender: 'system',
        timestamp: Date.now(),
      },
    ],
  },
  execution: {
    maxDuration: 25000,
    maxSteps: 40,
  },
  verification: {
    rules: [
      {
        id: 'relationships-formed',
        type: 'llm',
        description: 'Multiple relationships should be formed between team members',
        weight: 5,
        config: {
          successCriteria: 'The system should identify collaborative relationships between Alice-Bob, Alice-Carol, Alice-David, Bob-Carol, Bob-David, Bob-Eve, Carol-David, and others based on their interactions',
        },
      },
      {
        id: 'relationship-types',
        type: 'llm',
        description: 'Different types of relationships should be identified',
        weight: 4,
        config: {
          successCriteria: 'The system should identify leadership (Alice), mentorship (Bob-Eve), collaboration (multiple pairs), and peer relationships',
        },
      },
      {
        id: 'relationship-strength',
        type: 'llm',
        description: 'Relationship strength should reflect interaction patterns',
        weight: 3,
        config: {
          successCriteria: 'Stronger relationships should be identified for pairs with more interactions (e.g., Alice-Bob, Bob-David) compared to those with fewer interactions',
        },
      },
      {
        id: 'newcomer-integration',
        type: 'llm',
        description: 'New team member integration should be tracked',
        weight: 3,
        config: {
          successCriteria: 'Eve should be identified as a new team member with developing relationships, particularly a mentorship relationship with Bob',
        },
      },
      {
        id: 'relationship-queries',
        type: 'llm',
        description: 'Relationship queries should return accurate information',
        weight: 4,
        config: {
          successCriteria: 'Queries about relationships should accurately reflect the collaborative dynamics, identifying Bob-Eve as mentor-mentee and strong collaborations between original team members',
        },
      },
    ],
    groundTruth: {
      expectedBehavior: 'System tracks relationship formation and evolution based on interactions, mentions, and collaborative patterns',
      successCriteria: [
        'All team member relationships are identified',
        'Relationship types are correctly inferred',
        'Relationship strength reflects interaction frequency and quality',
        'Queries return accurate relationship information',
      ],
    },
  },
  benchmarks: {
    maxDuration: 25000,
    targetAccuracy: 0.85,
    customMetrics: [
      { name: 'relationships_identified', threshold: 8 },
      { name: 'relationship_types', threshold: 3 },
      { name: 'accurate_queries', threshold: 2 },
    ],
  },
};

export default relationshipBuildingScenario; 