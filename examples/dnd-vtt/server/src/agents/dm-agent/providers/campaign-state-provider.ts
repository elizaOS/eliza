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
  
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const campaignId = runtime.getSetting('campaignId') as string;
    
    if (!campaignId) {
      return { text: 'No active campaign.' };
    }
    
    try {
      // Fetch campaign data
      const campaign = await campaignRepository.getById(campaignId);
      
      if (!campaign) {
        return { text: 'Campaign not found.' };
      }
      
      // Get current session
      const currentSession = await campaignRepository.getLatestSession(campaignId);
      
      // Get stored game time
      const storedRaw = runtime.getSetting('campaignState');
      let storedState: CampaignState | null = null;
      if (storedRaw && typeof storedRaw === 'string') {
        try {
          storedState = JSON.parse(storedRaw) as CampaignState;
        } catch {
          storedState = null;
        }
      }
      
      const currentTime = storedState?.currentTime || {
        year: 1490,
        month: 1,
        day: 1,
        hour: 8,
        minute: 0,
      };
      
      // Build context string
      let context = `## Campaign: ${campaign.name}\n`;
      context += `**Setting:** ${campaign.setting ?? 'Not specified'}\n`;
      context += `**Tone:** ${campaign.tone ?? 'Not specified'}\n`;
      context += `**Session:** ${campaign.sessionCount ?? 0}${currentSession ? ` (current: #${currentSession.sessionNumber})` : ''}\n`;
      const totalPlayTime = campaign.totalPlayTime ?? 0;
      context += `**Total Play Time:** ${Math.floor(totalPlayTime / 60)}h ${totalPlayTime % 60}m\n\n`;
      
      // In-game time
      context += `### Current Time\n`;
      context += `**Date:** ${formatGameTime(currentTime)}\n`;
      context += `**Time of Day:** ${getTimeOfDay(currentTime.hour)}\n\n`;
      
      // Campaign themes and content warnings
      if (campaign.themes && campaign.themes.length > 0) {
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
        context += `**Started:** ${new Date(currentSession.startedAt).toLocaleString()}\n`;
        
        if (currentSession.summary) {
          if (currentSession.summary.keyEvents?.length > 0) {
            context += `**Key Events So Far:**\n`;
            context += currentSession.summary.keyEvents.map(e => `- ${e}`).join('\n');
            context += '\n';
          }
        }
      }
      
      return { text: context };
      
    } catch (error) {
      console.error('Error fetching campaign state:', error);
      return { text: 'Error loading campaign state.' };
    }
  },
};

export default campaignStateProvider;
