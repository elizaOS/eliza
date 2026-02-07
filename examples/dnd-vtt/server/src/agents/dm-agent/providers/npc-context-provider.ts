/**
 * NPC Context Provider
 * Provides detailed NPC information for roleplaying
 */

import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import type { NPC } from '../../../types';
import { locationRepository } from '../../../persistence';

export const npcContextProvider: Provider = {
  name: 'npcContext',
  description: 'Provides detailed NPC profiles for roleplaying interactions',
  
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const campaignId = runtime.getSetting('campaignId') as string;
    const activeNpcId = runtime.getSetting('activeNpcId') as string;
    
    if (!campaignId) {
      return { text: 'No active campaign.' };
    }
    
    // If there's a specific NPC being interacted with
    if (activeNpcId) {
      try {
        const npc = await locationRepository.getNPCById(activeNpcId);
        if (npc) {
          return { text: formatDetailedNPC(npc) };
        }
      } catch (error) {
        console.error('Error fetching NPC:', error);
      }
    }
    
    // Otherwise, provide context about nearby NPCs
    const currentLocationId = runtime.getSetting('currentLocationId') as string;
    
    if (!currentLocationId) {
      return { text: 'No NPCs in context.' };
    }
    
    try {
      const npcs = await locationRepository.getNPCsAtLocation(currentLocationId);
      
      if (npcs.length === 0) {
        return { text: 'No NPCs at current location.' };
      }
      
      let context = `## NPCs at Current Location\n\n`;
      
      for (const npc of npcs) {
        context += formatNPCSummary(npc);
        context += '\n';
      }
      
      return { text: context };
      
    } catch (error) {
      console.error('Error fetching NPCs:', error);
      return { text: 'Error loading NPC information.' };
    }
  },
};

function formatDetailedNPC(npc: NPC): string {
  let context = `## NPC Profile: ${npc.name}\n\n`;
  
  // Basic info
  if (npc.race) {
    context += `**Race:** ${npc.race}\n`;
  }
  if (npc.occupation) {
    context += `**Occupation:** ${npc.occupation}\n`;
  }
  context += `**Type:** ${npc.type}\n\n`;
  
  // Personality and motivation
  if (npc.personality) {
    context += `### Personality\n`;
    context += npc.personality;
    context += '\n\n';
  }
  
  if (npc.motivation) {
    context += `### Motivation\n`;
    context += npc.motivation;
    context += '\n\n';
  }
  
  // Party relationship
  const dispositionValue = npc.partyDisposition ?? 50;
  const disposition = getDispositionDetail(dispositionValue);
  context += `### Relationship with Party\n`;
  context += `**Disposition:** ${disposition.label} (${dispositionValue}/100)\n`;
  context += `${disposition.description}\n\n`;
  
  // Interaction history
  const interactionCount = npc.interactionCount ?? 0;
  if (interactionCount > 0) {
    context += `*Has interacted with the party ${interactionCount} time(s).*\n`;
    if (npc.lastInteraction) {
      context += `*Last interaction: ${new Date(npc.lastInteraction).toLocaleString()}*\n`;
    }
    context += '\n';
  } else {
    context += `*Has not yet interacted with the party.*\n\n`;
  }
  
  // Combat readiness (if relevant)
  if (npc.isHostile || dispositionValue < 25) {
    context += `### Combat Stats\n`;
    if (npc.hp) {
      context += `**HP:** ${npc.hp.current}/${npc.hp.max}\n`;
    }
    if (npc.ac !== undefined) {
      context += `**AC:** ${npc.ac}\n`;
    }
    if (npc.challengeRating !== undefined) {
      context += `**CR:** ${npc.challengeRating}\n`;
    }
  }
  
  // Roleplaying guidance
  context += `### Roleplaying Notes\n`;
  context += `- Speak in a manner befitting a ${npc.race ?? 'unknown'} ${npc.occupation || npc.type}\n`;
  context += `- Their ${disposition.label.toLowerCase()} disposition should color interactions\n`;
  context += `- Consider their motivation when determining responses\n`;
  
  return context;
}

function formatNPCSummary(npc: NPC): string {
  const dispositionValue = npc.partyDisposition ?? 50;
  const disposition = getDispositionDetail(dispositionValue);
  
  let summary = `### ${npc.name}\n`;
  summary += `${npc.race ?? 'Unknown'} ${npc.occupation || npc.type} | ${disposition.label}\n`;
  if (npc.personality) {
    summary += `*${truncate(npc.personality, 100)}*\n`;
  }
  
  if (npc.isHostile) {
    summary += `**Hostile**\n`;
  }
  
  return summary;
}

function getDispositionDetail(disposition: number): { label: string; description: string } {
  if (disposition >= 90) {
    return { 
      label: 'Devoted', 
      description: 'Considers the party close allies or friends. Will go out of their way to help.' 
    };
  }
  if (disposition >= 75) {
    return { 
      label: 'Friendly', 
      description: 'Positively disposed toward the party. Willing to help and share information.' 
    };
  }
  if (disposition >= 60) {
    return { 
      label: 'Amicable', 
      description: 'Generally positive but not invested. Will help if convenient.' 
    };
  }
  if (disposition >= 40) {
    return { 
      label: 'Neutral', 
      description: 'No particular feelings toward the party. Interactions are transactional.' 
    };
  }
  if (disposition >= 25) {
    return { 
      label: 'Unfriendly', 
      description: 'Dislikes the party. Reluctant to help and may be obstructive.' 
    };
  }
  if (disposition >= 10) {
    return { 
      label: 'Hostile', 
      description: 'Actively opposed to the party. May attack or work against them.' 
    };
  }
  return { 
    label: 'Antagonistic', 
    description: 'Considers the party enemies. Will attack on sight or actively sabotage.' 
  };
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

export default npcContextProvider;
