/**
 * Describe Location Action
 * Generates rich descriptions for game locations
 */

import type { 
  Action, 
  IAgentRuntime, 
  Memory, 
  State, 
  HandlerCallback 
} from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import type { Location } from '../../../types';

export interface DescribeLocationParams {
  locationId: string;
  detailLevel: 'brief' | 'standard' | 'detailed';
  includeExits?: boolean;
  includeNPCs?: boolean;
  includePointsOfInterest?: boolean;
  firstVisit?: boolean;
}

export const describeLocationAction: Action = {
  name: 'DESCRIBE_LOCATION',
  description: 'Generate a description of the current location for players',
  
  similes: [
    'describe this place',
    'look around',
    'what do we see',
    'describe the room',
    'examine surroundings',
  ],
  
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'We enter the tavern.',
          action: 'DESCRIBE_LOCATION',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'The Rusty Anchor tavern wraps around you like a warm embrace as you step inside. Firelight dances across rough-hewn timber walls adorned with fishing nets and maritime curios. The air is thick with pipe smoke, roasting meat, and the yeasty aroma of fresh ale. A half-dozen patrons occupy the common room - a mix of weathered fishermen and traveling merchants - their conversations creating a low murmur punctuated by occasional laughter.\n\nBehind the bar, a stout dwarven woman with gray-streaked braids polishes tankards with practiced efficiency. She glances up at your entrance, her eyes sharp but not unfriendly. To your left, a narrow staircase leads to the rooms above. To your right, a door marked "Private" stands slightly ajar.',
        },
      },
    ],
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const role = await runtime.getSetting('role');
    return role === 'dm';
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ) => {
    const params = (options ?? {}) as unknown as DescribeLocationParams;
    
    // Get location data from campaign state
    const location = await getLocationData(runtime, params.locationId);
    
    if (!location) {
      if (callback) {
        await callback({
          text: 'Unable to find location information.',
        });
      }
      return { success: false };
    }
    
    // Build the description prompt
    const prompt = buildLocationPrompt(location, params);
    
    // Generate description
    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      maxTokens: params.detailLevel === 'detailed' ? 600 : params.detailLevel === 'brief' ? 200 : 400,
    });
    
    if (callback) {
      await callback({
        text: response,
      });
    }
    
    // Mark location as discovered if first visit
    if (params.firstVisit) {
      const discoveredPayload = {
        runtime,
        locationId: params.locationId,
        locationName: location.name,
        timestamp: new Date(),
      };
      await runtime.emitEvent('location_discovered', discoveredPayload);
    }
    
    return undefined;
  },
};

async function getLocationData(
  runtime: IAgentRuntime,
  locationId: string
): Promise<Location | null> {
  const raw = runtime.getSetting('campaignState');
  if (raw && typeof raw === 'string') {
    try {
      const state = JSON.parse(raw) as { locations?: Record<string, Location> };
      return state.locations?.[locationId] || null;
    } catch {
      return null;
    }
  }
  return null;
}

function buildLocationPrompt(location: Location, params: DescribeLocationParams): string {
  let prompt = `Generate a ${params.detailLevel} description of this D&D location:\n\n`;
  
  prompt += `Name: ${location.name}\n`;
  prompt += `Type: ${location.type}\n`;
  prompt += `Description: ${location.description}\n`;
  prompt += `Danger Level: ${location.dangerLevel ?? 0}/10\n`;
  
  if (params.firstVisit) {
    prompt += `\nThis is the party's FIRST TIME visiting this location. Make the description impactful and memorable.\n`;
  }
  
  if (params.includePointsOfInterest && location.pointsOfInterest && location.pointsOfInterest.length > 0) {
    prompt += `\nPoints of Interest to mention:\n`;
    for (const poi of location.pointsOfInterest) {
      prompt += `- ${poi.name}: ${poi.description}\n`;
    }
  }
  
  if (params.includeNPCs && location.npcs && location.npcs.length > 0) {
    prompt += `\nNPCs present: ${location.npcs.join(', ')}\n`;
    prompt += `Incorporate these NPCs naturally into the scene.\n`;
  }
  
  if (params.includeExits) {
    prompt += `\nMention visible exits and paths.\n`;
  }
  
  const lengthGuidance = {
    brief: 'Write 1-2 sentences.',
    standard: 'Write 2-3 paragraphs.',
    detailed: 'Write 3-5 paragraphs with rich sensory details.',
  };
  
  prompt += `\n${lengthGuidance[params.detailLevel]} Use second person. Engage multiple senses. Match the tone to the danger level.`;
  
  return prompt;
}

export default describeLocationAction;
