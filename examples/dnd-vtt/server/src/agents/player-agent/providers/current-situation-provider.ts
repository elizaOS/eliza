/**
 * Current Situation Provider
 * Provides context about the current game state
 */

import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import type { Location, GameTime } from '../../../types';
import { formatGameTime, getTimeOfDay } from '../../../types';
import { locationRepository } from '../../../persistence';

export const currentSituationProvider: Provider = {
  name: 'currentSituation',
  description: 'Provides context about where the character is and what\'s happening',
  
  get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const campaignState = await runtime.getSetting('campaignState') as {
      currentTime?: GameTime;
      currentLocationId?: string;
      recentEvents?: string[];
    } | null;
    
    if (!campaignState) {
      return { text: 'The situation is unclear.' };
    }
    
    let context = `## Current Situation\n\n`;
    
    // Time of day
    if (campaignState.currentTime) {
      const time = campaignState.currentTime;
      const timeOfDay = getTimeOfDay(time.hour);
      context += `**Time:** ${formatGameTime(time)} (${timeOfDay})\n`;
    }
    
    // Location
    if (campaignState.currentLocationId) {
      try {
        const location = await locationRepository.getById(campaignState.currentLocationId);
        if (location) {
          context += `**Location:** ${location.name}`;
          if (location.type) {
            context += ` (${location.type})`;
          }
          context += '\n';
          
          // Danger level
          if ((location.dangerLevel ?? 0) > 2) {
            context += `⚠️ **Danger Level:** ${location.dangerLevel ?? 0}/5\n`;
          }
        }
      } catch (error) {
        // Location fetch failed, continue without it
      }
    }
    
    // Recent events
    if (campaignState.recentEvents && campaignState.recentEvents.length > 0) {
      context += `\n### Recent Events\n`;
      for (const event of campaignState.recentEvents.slice(-3)) {
        context += `- ${event}\n`;
      }
    }
    
    // Check for combat state
    const combatState = await runtime.getSetting('combatState') as unknown as { isActive?: boolean } | null;
    if (combatState?.isActive) {
      context += `\n⚔️ **COMBAT IS ACTIVE**\n`;
    }
    
    return { text: context };
  },
};

export default currentSituationProvider;
