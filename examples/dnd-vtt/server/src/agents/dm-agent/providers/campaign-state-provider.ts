/**
 * Campaign State Provider
 * Provides current campaign context to the DM agent
 */

import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import type { Campaign, Session, GameTime } from '../../../types';
import { formatGameTime, getTimeOfDay } from '../../../types';
import { campaignRepository } from '../../../persistence';

export interface CampaignState {
  campaign: Campaign | null;
  currentSession: Session | null;
  currentTime: GameTime;
  sessionNumber: number;
  totalPlayTime: number;
  majorEvents: string[];
}

export const campaignStateProvider: Provider = {
  name: 'campaignState',
  description: 'Provides current campaign and session information',
  
  get: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<string> => {
    const campaignId = await runtime.getSetting('campaignId') as string;
    
    if (!campaignId) {
      return 'No active campaign.';
    }
    
    try {
      // Fetch campaign data
      const campaign = await campaignRepository.getById(campaignId);
      
      if (!campaign) {
        return 'Campaign not found.';
      }
      
      // Get current session
      const currentSession = await campaignRepository.getLatestSession(campaignId);
      
      // Get stored game time
      const storedState = await runtime.getSetting('campaignState') as CampaignState | null;
      const currentTime = storedState?.currentTime || {
        year: 1490,
        month: 1,
        day: 1,
        hour: 8,
        minute: 0,
      };
      
      // Build context string
      let context = `## Campaign: ${campaign.name}\n`;
      context += `**Setting:** ${campaign.setting}\n`;
      context += `**Tone:** ${campaign.tone}\n`;
      context += `**Session:** ${campaign.sessionCount}${currentSession ? ` (current: #${currentSession.sessionNumber})` : ''}\n`;
      context += `**Total Play Time:** ${Math.floor(campaign.totalPlayTime / 60)}h ${campaign.totalPlayTime % 60}m\n\n`;
      
      // In-game time
      context += `### Current Time\n`;
      context += `**Date:** ${formatGameTime(currentTime)}\n`;
      context += `**Time of Day:** ${getTimeOfDay(currentTime.hour)}\n\n`;
      
      // Campaign themes and content warnings
      if (campaign.themes.length > 0) {
        context += `### Themes\n`;
        context += campaign.themes.map(t => `- ${t}`).join('\n');
        context += '\n\n';
      }
      
      // Ongoing plot threads
      if (campaign.description) {
        context += `### Campaign Overview\n`;
        context += campaign.description;
        context += '\n\n';
      }
      
      // Session-specific info
      if (currentSession) {
        context += `### This Session\n`;
        context += `**Started:** ${currentSession.startedAt.toLocaleString()}\n`;
        
        if (currentSession.summary) {
          if (currentSession.summary.keyEvents?.length > 0) {
            context += `**Key Events So Far:**\n`;
            context += currentSession.summary.keyEvents.map(e => `- ${e}`).join('\n');
            context += '\n';
          }
        }
      }
      
      return context;
      
    } catch (error) {
      console.error('Error fetching campaign state:', error);
      return 'Error loading campaign state.';
    }
  },
};

export default campaignStateProvider;
