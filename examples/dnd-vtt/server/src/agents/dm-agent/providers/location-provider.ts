/**
 * Location Provider
 * Provides current location context to the DM agent
 */

import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import type { Location } from '../../../types';
import { locationRepository } from '../../../persistence';

export const locationProvider: Provider = {
  name: 'location',
  description: 'Provides current location details and nearby areas',
  
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const campaignId = runtime.getSetting('campaignId') as string;
    const currentLocationId = runtime.getSetting('currentLocationId') as string;
    
    if (!campaignId || !currentLocationId) {
      return { text: 'Current location unknown.' };
    }
    
    try {
      // Get current location
      const location = await locationRepository.getById(currentLocationId);
      
      if (!location) {
        return { text: 'Current location not found.' };
      }
      
      const dangerLevel = location.dangerLevel ?? 0;
      
      let context = `## Current Location: ${location.name}\n`;
      context += `**Type:** ${formatLocationType(location.type)}\n`;
      context += `**Danger Level:** ${'!'.repeat(Math.min(dangerLevel, 5))} (${dangerLevel}/5)\n\n`;
      
      // Description
      context += `### Description\n`;
      context += location.description;
      context += '\n\n';
      
      // Points of interest
      if (location.pointsOfInterest && location.pointsOfInterest.length > 0) {
        context += `### Points of Interest\n`;
        for (const poi of location.pointsOfInterest) {
          context += `- **${poi.name}:** ${poi.description}\n`;
        }
        context += '\n';
      }
      
      // Available services (for settlements)
      if (location.availableServices && location.availableServices.length > 0) {
        context += `### Available Services\n`;
        context += location.availableServices.map(s => `- ${s}`).join('\n');
        context += '\n\n';
      }
      
      // Tags for narrative inspiration
      if (location.tags && location.tags.length > 0) {
        context += `**Atmosphere:** ${location.tags.join(', ')}\n\n`;
      }
      
      // NPCs present
      const npcs = await locationRepository.getNPCsAtLocation(currentLocationId);
      if (npcs.length > 0) {
        context += `### NPCs Present\n`;
        for (const npc of npcs) {
          const disposition = getDispositionDescription(npc.partyDisposition ?? 50);
          context += `- **${npc.name}** (${npc.race ?? 'Unknown'} ${npc.occupation || npc.type}) - ${disposition}\n`;
        }
        context += '\n';
      }
      
      // Child locations (sub-areas)
      const childLocations = await locationRepository.getChildLocations(currentLocationId);
      if (childLocations.length > 0) {
        context += `### Areas Within\n`;
        for (const child of childLocations) {
          const discovered = child.isDiscovered ? '' : ' (undiscovered)';
          context += `- ${child.name}${discovered}\n`;
        }
        context += '\n';
      }
      
      // Parent location context
      if (location.parentLocationId) {
        const parent = await locationRepository.getById(location.parentLocationId);
        if (parent) {
          context += `**Within:** ${parent.name}\n`;
        }
      }
      
      // Visit history
      const visitCount = location.visitCount ?? 0;
      if (visitCount > 1) {
        context += `*The party has visited here ${visitCount} times.*\n`;
      } else if (visitCount === 1) {
        context += `*This is the party's first visit here.*\n`;
      }
      
      return { text: context };
      
    } catch (error) {
      console.error('Error fetching location:', error);
      return { text: 'Error loading location information.' };
    }
  },
};

function formatLocationType(type: string): string {
  const typeLabels: Record<string, string> = {
    city: 'City',
    town: 'Town',
    village: 'Village',
    wilderness: 'Wilderness',
    dungeon: 'Dungeon',
    building: 'Building',
    room: 'Room',
    landmark: 'Landmark',
    region: 'Region',
  };
  
  return typeLabels[type] || type;
}

function getDispositionDescription(disposition: number): string {
  if (disposition >= 75) return 'Friendly';
  if (disposition >= 50) return 'Neutral';
  if (disposition >= 25) return 'Unfriendly';
  return 'Hostile';
}

export default locationProvider;
