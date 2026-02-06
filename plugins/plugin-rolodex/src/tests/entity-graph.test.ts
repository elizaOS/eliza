import { type TestSuite, type IAgentRuntime, ChannelType } from '@elizaos/core';
import { ConversationSimulator, type ConversationScript } from './ConversationSimulator';
import { ScenarioVerifier } from './ScenarioVerifier';

// Scenario demonstrating passive entity graph building
const entityGraphBuildingScript: ConversationScript = {
  name: 'Passive Entity Graph Building',
  description: 'Demonstrates how the system passively builds an entity graph from natural conversation',
  room: { name: 'team-chat', type: ChannelType.GROUP },
  participants: [
    { name: 'Alex Developer', metadata: { role: 'developer' } },
    { name: 'Sarah Manager', metadata: { role: 'manager' } },
    { name: 'Mike Designer', metadata: { role: 'designer' } },
    { name: 'Emma Intern', metadata: { role: 'intern', isNew: true } },
  ],
  steps: [
    // Initial introductions
    { 
      from: 'Sarah Manager', 
      content: "Good morning team! Let's welcome Emma, our new intern. Emma will be working with Mike on the UI redesign." 
    },
    { 
      from: 'Emma Intern', 
      content: "Hi everyone! I'm Emma, excited to join the team. You can find me on GitHub @emma-dev and Twitter @emma_designs" 
    },
    { 
      from: 'Mike Designer', 
      content: "Welcome Emma! I'm Mike, the lead designer. Looking forward to working with you on the redesign project." 
    },
    { 
      from: 'Alex Developer', 
      content: "Hey Emma, I'm Alex. I handle the backend. If you need any API help, just ping me. My GitHub is @alexcodes" 
    },
    
    // Natural conversation showing relationships
    { 
      from: 'Sarah Manager', 
      content: "Alex, can you help Emma set up her dev environment? You're always great with onboarding." 
    },
    { 
      from: 'Alex Developer', 
      content: "Sure thing, Sarah. Emma, let's sync after this meeting. I'll walk you through our setup." 
    },
    { 
      from: 'Emma Intern', 
      content: "Thanks Alex! Really appreciate the help." 
    },
    
    // Some time passes - relationship development
    { 
      from: 'Mike Designer', 
      content: "Emma did an amazing job on the mockups! She's picking things up really quickly.",
      delay: 2000 
    },
    { 
      from: 'Sarah Manager', 
      content: "That's wonderful to hear, Mike. Emma, keep up the great work!" 
    },
    { 
      from: 'Emma Intern', 
      content: "Thanks Mike and Sarah! Mike has been an excellent mentor." 
    },
    
    // Showing trust building
    { 
      from: 'Alex Developer', 
      content: "Emma found and fixed that tricky CSS bug yesterday. Saved us hours of debugging!" 
    },
    { 
      from: 'Mike Designer', 
      content: "She's definitely becoming a valuable part of the team. Great problem-solving skills." 
    },
    
    // Community building
    { 
      from: 'Sarah Manager', 
      content: "Team, our quarterly presentation is next week. Mike and Emma will present the new designs, Alex will cover the technical implementation." 
    },
    { 
      from: 'Mike Designer', 
      content: "Emma and I have been preparing. We make a good team!" 
    },
    { 
      from: 'Alex Developer', 
      content: "Looking forward to it. This project has really brought us all together." 
    },
  ],
};

export const entityGraphTestSuite: TestSuite = {
  name: 'Entity Graph Building Tests',
  tests: [
    {
      name: 'Passive Entity Graph Building from Conversation',
      fn: async (runtime: IAgentRuntime) => {
        const simulator = new ConversationSimulator(runtime);
        const verifier = new ScenarioVerifier(runtime);
        
        await simulator.runConversation(entityGraphBuildingScript);
        await simulator.waitForEvaluators();

        // Get all participants
        const alex = simulator.getUser('Alex Developer');
        const sarah = simulator.getUser('Sarah Manager');
        const mike = simulator.getUser('Mike Designer');
        const emma = simulator.getUser('Emma Intern');

        if (!alex || !sarah || !mike || !emma) {
          throw new Error('Test users not found');
        }

        // Verify entities were created with metadata
        await verifier.verifyEntity(emma.entity.id!, {
          names: ['Emma Intern'],
          platformIdentities: [
            { platform: 'github', handle: '@emma-dev' },
            { platform: 'twitter', handle: '@emma_designs' },
          ],
        });

        await verifier.verifyEntity(alex.entity.id!, {
          names: ['Alex Developer'],
          platformIdentities: [
            { platform: 'github', handle: '@alexcodes' },
          ],
        });

        // Verify relationships were built
        // Mike <-> Emma (mentor/mentee, colleagues)
        await verifier.verifyRelationship(mike.entity.id!, emma.entity.id!, {
          exists: true,
          type: 'colleague',
          sentiment: 'positive',
          minStrength: 0.6, // Should be strong due to working together
        });

        // Alex <-> Emma (helpful colleague)
        await verifier.verifyRelationship(alex.entity.id!, emma.entity.id!, {
          exists: true,
          type: 'colleague',
          sentiment: 'positive',
          minStrength: 0.4,
        });

        // Sarah <-> Team members (manager relationships)
        await verifier.verifyRelationship(sarah.entity.id!, emma.entity.id!, {
          exists: true,
          type: 'colleague',
          sentiment: 'positive',
        });

        // Verify trust metrics were updated
        await verifier.verifyEntity(emma.entity.id!, {
          trustMetrics: {
            minHelpfulness: 0.3, // Should be seen as helpful after fixing bug
            maxSuspicionLevel: 0.2, // Should be low suspicion
          },
        });

        // The relationships have been verified above
        // The entity graph should show a connected team with positive relationships

        await simulator.cleanup();
      },
    },
    {
      name: 'Entity Graph Shows Relationship Evolution',
      fn: async (runtime: IAgentRuntime) => {
        const evolutionScript: ConversationScript = {
          name: 'Relationship Evolution',
          description: 'Shows how relationships evolve over time',
          room: { name: 'project-room', type: ChannelType.GROUP },
          participants: [
            { name: 'Alice', metadata: {} },
            { name: 'Bob', metadata: {} },
          ],
          steps: [
            // First interaction - strangers
            { from: 'Alice', content: "Hi, are you the new developer on the team?" },
            { from: 'Bob', content: "Yes, I'm Bob. Just started today. And you are?" },
            { from: 'Alice', content: "I'm Alice, I work on the frontend. Welcome!" },
            
            // Working together - colleagues
            { from: 'Alice', content: "Bob, could you help me with this API endpoint?", delay: 1000 },
            { from: 'Bob', content: "Sure, let me take a look. Ah, I see the issue..." },
            { from: 'Alice', content: "That worked perfectly! Thanks for your help." },
            
            // Building friendship
            { from: 'Bob', content: "Want to grab coffee after work? Would be nice to chat more.", delay: 1000 },
            { from: 'Alice', content: "That sounds great! There's a nice place around the corner." },
            { from: 'Bob', content: "Awesome, see you at 5!" },
            
            // Established friendship
            { from: 'Alice', content: "That was a fun weekend! Thanks for showing me that hiking trail.", delay: 2000 },
            { from: 'Bob', content: "Glad you enjoyed it! We should do it again sometime." },
            { from: 'Alice', content: "Definitely! You're a great friend, Bob." },
          ],
        };

        const simulator = new ConversationSimulator(runtime);
        const verifier = new ScenarioVerifier(runtime);
        
        await simulator.runConversation(evolutionScript);
        await simulator.waitForEvaluators();

        const alice = simulator.getUser('Alice');
        const bob = simulator.getUser('Bob');

        if (!alice || !bob) {
          throw new Error('Test users not found');
        }

        // Verify relationship evolved to friend
        await verifier.verifyRelationship(alice.entity.id!, bob.entity.id!, {
          exists: true,
          type: 'friend', // Should have evolved from colleague to friend
          sentiment: 'positive',
          minStrength: 0.7, // Should be strong after multiple positive interactions
        });

        await simulator.cleanup();
      },
    },
  ],
}; 