import { describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { UUID } from '@elizaos/core';
import { createTestMessage } from './setup';

// Import all agents
import { communityManager } from '../src/communityManager';
import { devRel } from '../src/devRel';
import { socialMediaManager } from '../src/socialMediaManager';
import { projectManager } from '../src/projectManager';
import { liaison } from '../src/liaison';
import { investmentManager } from '../src/investmentManager';

// Define a type for agents to simplify testing
type Agent = {
  character: {
    name: string;
    bio?: string[] | string;
    system?: string;
    plugins?: string[];
    messageExamples?: any[];
    [key: string]: any;
  };
  init?: Function;
  [key: string]: any;
};

// Define agent-specific expectations
const agentExpectations: Record<string, {
  bioKeywords: RegExp;
  systemKeywords: RegExp;
  messageKeywords: string[];
  requiredPlugins: string[];
}> = {
  'communityManager': {
    bioKeywords: /community|message|respond|moderat/,
    systemKeywords: /community|relevant|user|trouble|moderat/,
    messageKeywords: ['toxic', 'mod', 'ban', 'drama'],
    requiredPlugins: ['@elizaos/plugin-discord']
  },
  'devRel': {
    bioKeywords: /developer|documentation|technical|support|community/,
    systemKeywords: /developer|technical|support|documentation|guide/,
    messageKeywords: ['help', 'support', 'assist', 'documentation', 'guide', 'tutorial', 'code'],
    requiredPlugins: []
  },
  'socialMediaManager': {
    bioKeywords: /social|media|tweet|content|post|strategy/,
    systemKeywords: /social|media|post|content|strategy|audience/,
    messageKeywords: ['post', 'tweet', 'content', 'engage', 'audience', 'follower', 'growth'],
    requiredPlugins: ['@elizaos/plugin-twitter']
  },
  'projectManager': {
    bioKeywords: /project|task|manage|plan|schedule|deadline/,
    systemKeywords: /project|task|manage|plan|schedule|deadline/,
    messageKeywords: ['task', 'project', 'deadline', 'plan', 'schedule', 'priorit'],
    requiredPlugins: []
  },
  'liaison': {
    bioKeywords: /connect|communicat|liaison|team|coordinate/,
    systemKeywords: /connect|communicat|liaison|team|coordinate/,
    messageKeywords: ['connect', 'introduce', 'team', 'communicat', 'collaborat', 'coordinate'],
    requiredPlugins: []
  },
  'investmentManager': {
    bioKeywords: /invest|portfolio|market|financ|asset|analysis/,
    systemKeywords: /invest|portfolio|market|financ|asset|analysis/,
    messageKeywords: ['invest', 'market', 'portfolio', 'risk', 'analysis', 'decision'],
    requiredPlugins: []
  }
};

// Map of agent names to agent objects
const agents: Record<string, Agent> = {
  communityManager,
  devRel,
  socialMediaManager,
  projectManager,
  liaison,
  investmentManager
};

describe('All Agents Character Verification', () => {
  // For each agent, run verification tests
  Object.entries(agents).forEach(([agentName, agent]) => {
    describe(`${agentName} Character Verification`, () => {
      const expectations = agentExpectations[agentName];
      
      if (!expectations) {
        it(`has no defined expectations for ${agentName}`, () => {
          console.warn(`No expectations defined for ${agentName}`);
          expect(true).toBe(true); // Placeholder test
        });
        return;
      }
      
      it(`should have appropriate message examples for its role`, () => {
        // Get all message examples from the character
        const { messageExamples } = agent.character;
        
        expect(messageExamples).toBeDefined();
        if (!messageExamples) return; // Satisfy type checker
        
        expect(Array.isArray(messageExamples)).toBe(true);
        
        // For each expected keyword, check if there are matching examples
        let matchingKeywordsCount = 0;
        
        for (const keyword of expectations.messageKeywords) {
          const matchingExamples = messageExamples.filter(conversation => {
            const text = JSON.stringify(conversation).toLowerCase();
            return text.includes(keyword);
          });
          
          if (matchingExamples.length > 0) {
            matchingKeywordsCount++;
          }
        }
        
        // Test passes if the character has examples matching at least 50% of expected keywords
        const minKeywordsRequired = Math.ceil(expectations.messageKeywords.length / 2);
        expect(matchingKeywordsCount).toBeGreaterThanOrEqual(minKeywordsRequired);
      });
      
      it(`should focus on its role in bio and system description`, () => {
        const { bio, system } = agent.character;
        
        // Verify bio contains appropriate focus
        expect(bio).toBeDefined();
        if (!bio) return; // Satisfy type checker
        
        // Bio can be array or string
        expect(Array.isArray(bio) || typeof bio === 'string').toBe(true);
        const combinedBio = typeof bio === 'string' ? bio : bio.join(' ');
        const bioText = combinedBio.toLowerCase();
        
        // Use a more forgiving approach - check for any keyword match rather than exact pattern
        const bioKeywordList = expectations.bioKeywords.source
          .replace(/\|/g, ' ')
          .replace(/\\|\//g, '')
          .split(' ');
        
        const hasBioKeywords = bioKeywordList.some(keyword => bioText.includes(keyword));
        expect(hasBioKeywords).toBe(true);
        
        // Verify system description focuses on appropriate role
        expect(system).toBeDefined();
        if (!system) return; // Satisfy type checker
        
        const systemDescription = system.toLowerCase();
        
        // Use a more forgiving approach for system too
        const systemKeywordList = expectations.systemKeywords.source
          .replace(/\|/g, ' ')
          .replace(/\\|\//g, '')
          .split(' ');
        
        const hasSystemKeywords = systemKeywordList.some(keyword => systemDescription.includes(keyword));
        expect(hasSystemKeywords).toBe(true);
      });
      
      it(`should have the correct plugins configured for its role`, () => {
        const { plugins } = agent.character;
        
        expect(plugins).toBeDefined();
        if (!plugins) return; // Satisfy type checker
        
        // Verify essential LLM plugins
        expect(plugins.some(p => p.includes('openai') || p.includes('anthropic'))).toBe(true);
        
        // Verify required role-specific plugins
        for (const requiredPlugin of expectations.requiredPlugins) {
          expect(plugins).toContain(requiredPlugin);
        }
      });
      
      it(`should have initialization function defined`, () => {
        expect(agent.init).toBeDefined();
      });
    });
  });
  
  // Verify that characters can handle relevant queries
  it('should simulate appropriate message queries for each agent', () => {
    const testRoomId = uuidv4() as UUID;
    const userEntityId = uuidv4() as UUID;
    
    // For each agent, create a relevant test message
    Object.entries(agents).forEach(([agentName, agent]) => {
      // Create a relevant query based on agent role
      let queryText = `@${agent.character.name} `;
      
      switch (agentName) {
        case 'communityManager':
          queryText += 'Can you help moderate this channel? There are some toxic users.';
          break;
        case 'devRel':
          queryText += 'Where can I find the documentation for the API?';
          break;
        case 'socialMediaManager':
          queryText += 'Can you help draft a tweet about our product launch?';
          break;
        case 'projectManager':
          queryText += 'We need to plan the next sprint and set priorities.';
          break;
        case 'liaison':
          queryText += 'Can you connect me with someone from the marketing team?';
          break;
        case 'investmentManager':
          queryText += 'What\'s your analysis of the current market conditions?';
          break;
        default:
          queryText += 'Can you help me with something related to your role?';
      }
      
      // Create the test message
      const testQuery = createTestMessage({
        text: queryText,
        entityId: userEntityId,
        roomId: testRoomId,
        userName: 'TestUser'
      });
      
      // Verify the message contains the agent's name and role-relevant content
      expect(testQuery.content?.text).toContain(agent.character.name);
      
      // This test only checks that we can create appropriate messages for each agent
      // It doesn't test the runtime response as that would require full agent runtime setup
      expect(testQuery.content?.text.length).toBeGreaterThan(0);
    });
  });
}); 