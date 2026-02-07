/**
 * Character Memory Provider
 * Provides character memories and relationships
 */

import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import { characterRepository } from '../../../persistence';

export const memoryProvider: Provider = {
  name: 'characterMemory',
  description: 'Provides character memories and relationships',
  
  get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const characterId = await runtime.getSetting('characterId') as string;
    
    if (!characterId) {
      return { text: 'No memories available.' };
    }
    
    try {
      let context = `## Character Memories\n\n`;
      
      // Get important memories
      const importantMemories = await characterRepository.getImportantMemories(characterId, 5);
      
      if (importantMemories.length > 0) {
        context += `### Key Memories\n`;
        for (const memory of importantMemories) {
          context += `- ${memory.content}`;
          if (memory.emotionalValence) {
            context += ` *(${memory.emotionalValence > 0 ? 'positive' : memory.emotionalValence < 0 ? 'negative' : 'neutral'})*`;
          }
          context += '\n';
        }
        context += '\n';
      }
      
      // Get recent memories
      const recentMemories = await characterRepository.getRecentMemories(characterId, 3);
      
      if (recentMemories.length > 0) {
        context += `### Recent Events\n`;
        for (const memory of recentMemories) {
          context += `- ${memory.content}\n`;
        }
        context += '\n';
      }
      
      // Get relationships
      const relationships = await characterRepository.getRelationships(characterId);
      
      if (relationships.length > 0) {
        context += `### Relationships\n`;
        
        // Sort by importance (disposition * familiarity)
        const sorted = relationships.sort((a, b) => 
          (b.disposition * b.familiarity) - (a.disposition * a.familiarity)
        );
        
        for (const rel of sorted.slice(0, 5)) {
          const dispositionLabel = getDispositionLabel(rel.disposition);
          const familiarityLabel = getFamiliarityLabel(rel.familiarity);
          
          context += `- **${rel.targetName}** (${rel.targetType}): ${dispositionLabel}, ${familiarityLabel}\n`;
        }
      }
      
      return { text: context || 'No significant memories yet.' };
      
    } catch (error) {
      console.error('Error fetching memories:', error);
      return { text: 'Error loading memories.' };
    }
  },
};

function getDispositionLabel(disposition: number): string {
  if (disposition >= 80) return 'trusted friend';
  if (disposition >= 60) return 'friendly';
  if (disposition >= 40) return 'neutral';
  if (disposition >= 20) return 'wary';
  return 'distrusted';
}

function getFamiliarityLabel(familiarity: number): string {
  if (familiarity >= 80) return 'well-known';
  if (familiarity >= 50) return 'familiar';
  if (familiarity >= 20) return 'acquaintance';
  return 'stranger';
}

export default memoryProvider;
