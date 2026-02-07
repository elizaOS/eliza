/**
 * World Event Provider
 * Provides recent world events and campaign history
 */

import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import type { WorldEvent, Quest, QuestObjective } from '../../../types';
import { worldRepository } from '../../../persistence';

export const worldEventProvider: Provider = {
  name: 'worldEvents',
  description: 'Provides recent important events and active quests',
  
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const campaignId = runtime.getSetting('campaignId') as string;
    
    if (!campaignId) {
      return { text: 'No active campaign.' };
    }
    
    try {
      let context = '';
      
      // Get recent important events
      const recentEvents = await worldRepository.getRecentImportantEvents(campaignId, 10);
      
      if (recentEvents.length > 0) {
        context += `## Recent Events\n\n`;
        
        // Group by importance
        const majorEvents = recentEvents.filter(e => e.importance >= 8);
        const notableEvents = recentEvents.filter(e => e.importance >= 5 && e.importance < 8);
        const minorEvents = recentEvents.filter(e => e.importance < 5);
        
        if (majorEvents.length > 0) {
          context += `### Major Events\n`;
          for (const event of majorEvents) {
            context += formatEvent(event);
          }
          context += '\n';
        }
        
        if (notableEvents.length > 0) {
          context += `### Notable Events\n`;
          for (const event of notableEvents) {
            context += formatEvent(event);
          }
          context += '\n';
        }
        
        if (minorEvents.length > 0) {
          context += `### Other Events\n`;
          for (const event of minorEvents) {
            context += `- ${event.description}\n`;
          }
          context += '\n';
        }
      }
      
      // Get active quests
      const activeQuests = await worldRepository.getActiveQuests(campaignId);
      
      if (activeQuests.length > 0) {
        context += `## Active Quests\n\n`;
        
        // Separate by type
        const mainQuests = activeQuests.filter(q => q.type === 'main');
        const sideQuests = activeQuests.filter(q => q.type === 'side' || q.type === 'personal' || q.type === 'faction');
        
        if (mainQuests.length > 0) {
          context += `### Main Quests\n`;
          for (const quest of mainQuests) {
            context += formatQuest(quest);
          }
          context += '\n';
        }
        
        if (sideQuests.length > 0) {
          context += `### Side Quests\n`;
          for (const quest of sideQuests) {
            context += formatQuest(quest);
          }
          context += '\n';
        }
      } else {
        context += `*No active quests.*\n`;
      }
      
      return { text: context || 'No significant events or quests recorded.' };
      
    } catch (error) {
      console.error('Error fetching world events:', error);
      return { text: 'Error loading world events.' };
    }
  },
};

function formatEvent(event: WorldEvent): string {
  let formatted = `- **${event.type.charAt(0).toUpperCase() + event.type.slice(1)}:** `;
  formatted += event.description;
  
  if (event.consequences && event.consequences.length > 0) {
    formatted += `\n  *Consequences: ${event.consequences.join('; ')}*`;
  }
  
  formatted += '\n';
  return formatted;
}

function formatQuest(quest: Quest): string {
  let formatted = `#### ${quest.name}\n`;
  formatted += `${quest.description}\n`;
  
  // Quest giver
  if (quest.giver) {
    formatted += `*Given by: ${quest.giver}*\n`;
  }
  
  // Objectives progress
  if (quest.objectives && quest.objectives.length > 0) {
    formatted += `**Objectives:**\n`;
    for (const obj of quest.objectives) {
      const isComplete = obj.isComplete ?? obj.completed ?? false;
      const checkbox = isComplete ? '[x]' : '[ ]';
      formatted += `${checkbox} ${obj.description}\n`;
    }
  }
  
  // Rewards
  if (quest.rewards) {
    const rewards: string[] = [];
    if (quest.rewards.experience) rewards.push(`${quest.rewards.experience} XP`);
    if (quest.rewards.gold) rewards.push(`${quest.rewards.gold} gp`);
    if (quest.rewards.items && quest.rewards.items.length > 0) {
      rewards.push(quest.rewards.items.join(', '));
    }
    if (rewards.length > 0) {
      formatted += `**Rewards:** ${rewards.join(', ')}\n`;
    }
  }
  
  formatted += '\n';
  return formatted;
}

export default worldEventProvider;
