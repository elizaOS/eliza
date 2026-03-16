/**
 * Memory Retrieval System
 * Handles semantic retrieval of relevant memories and context
 */

import type { CharacterMemory, WorldEvent, NPC } from '../types';
import { 
  characterRepository, 
  worldRepository, 
  locationRepository,
} from '../persistence';

export interface MemoryQuery {
  campaignId: string;
  characterId?: string;
  query: string;
  contextTypes?: Array<'character' | 'world' | 'npc' | 'location'>;
  maxResults?: number;
  minImportance?: number;
}

export interface RetrievedMemory {
  type: 'character' | 'world' | 'npc' | 'location';
  content: string;
  importance: number;
  relevanceScore: number;
  metadata: Record<string, unknown>;
}

/**
 * Retrieve relevant memories based on a query.
 * Uses keyword-based matching against the database.
 * The embeddings table exists in the schema for future vector search integration.
 */
export async function retrieveRelevantMemories(
  query: MemoryQuery
): Promise<RetrievedMemory[]> {
  const results: RetrievedMemory[] = [];
  const maxResults = query.maxResults || 10;
  const minImportance = query.minImportance || 3;
  
  // Extract keywords from query
  const keywords = extractKeywords(query.query);
  
  const contextTypes = query.contextTypes || ['character', 'world', 'npc', 'location'];
  
  // Search character memories
  if (contextTypes.includes('character') && query.characterId) {
    const memories = await characterRepository.getImportantMemories(
      query.characterId,
      20
    );
    
    for (const memory of memories) {
      const relevance = calculateRelevance(memory.content, keywords);
      if (relevance > 0.3 && memory.importance >= minImportance) {
        results.push({
          type: 'character',
          content: memory.content,
          importance: memory.importance,
          relevanceScore: relevance,
          metadata: {
            memoryType: memory.type,
            emotionalValence: memory.emotionalValence,
            createdAt: memory.createdAt,
          },
        });
      }
    }
  }
  
  // Search world events
  if (contextTypes.includes('world')) {
    const events = await worldRepository.getRecentImportantEvents(
      query.campaignId,
      30
    );
    
    for (const event of events) {
      const relevance = calculateRelevance(event.description, keywords);
      if (relevance > 0.3 && event.importance >= minImportance) {
        results.push({
          type: 'world',
          content: event.description,
          importance: event.importance,
          relevanceScore: relevance,
          metadata: {
            eventType: event.type,
            gameTime: event.gameTime,
            consequences: event.consequences,
          },
        });
      }
    }
  }
  
  // Search NPCs
  if (contextTypes.includes('npc')) {
    const npcs = await locationRepository.getNPCsByCampaign(query.campaignId);
    
    for (const npc of npcs) {
      const npcContent = `${npc.name}: ${npc.personality}. ${npc.motivation || ''}`;
      const relevance = calculateRelevance(npcContent, keywords);
      
      if (relevance > 0.3) {
        results.push({
          type: 'npc',
          content: `${npc.name} (${npc.race} ${npc.occupation || npc.type}): ${npc.personality}`,
          importance: (npc.interactionCount ?? 0) > 3 ? 7 : 4,
          relevanceScore: relevance,
          metadata: {
            npcId: npc.id,
            disposition: npc.partyDisposition,
            location: npc.currentLocationId,
          },
        });
      }
    }
  }
  
  // Search locations
  if (contextTypes.includes('location')) {
    const locations = await locationRepository.getByCampaign(query.campaignId);
    
    for (const location of locations) {
      const locationContent = `${location.name}: ${location.description}`;
      const relevance = calculateRelevance(locationContent, keywords);
      
      if (relevance > 0.3 && location.isDiscovered) {
        results.push({
          type: 'location',
          content: `${location.name} (${location.type}): ${location.description.substring(0, 200)}`,
          importance: (location.visitCount ?? 0) > 2 ? 6 : 4,
          relevanceScore: relevance,
          metadata: {
            locationId: location.id,
            visitCount: location.visitCount,
            dangerLevel: location.dangerLevel,
          },
        });
      }
    }
  }
  
  // Sort by combined relevance and importance
  results.sort((a, b) => {
    const scoreA = a.relevanceScore * 0.6 + (a.importance / 10) * 0.4;
    const scoreB = b.relevanceScore * 0.6 + (b.importance / 10) * 0.4;
    return scoreB - scoreA;
  });
  
  return results.slice(0, maxResults);
}

/**
 * Extract keywords from a query string
 */
function extractKeywords(query: string): string[] {
  // Remove common words and split into keywords
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'must', 'shall',
    'this', 'that', 'these', 'those', 'it', 'its',
    'and', 'or', 'but', 'if', 'then', 'else',
    'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how',
    'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
    'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
    'so', 'than', 'too', 'very', 'just', 'about', 'after', 'before',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his',
    'she', 'her', 'they', 'them', 'their',
  ]);
  
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
}

/**
 * Calculate relevance score between content and keywords
 */
function calculateRelevance(content: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  
  const contentLower = content.toLowerCase();
  let matchCount = 0;
  let totalWeight = 0;
  
  for (const keyword of keywords) {
    // Exact match
    if (contentLower.includes(keyword)) {
      matchCount++;
      totalWeight += 1;
    }
    
    // Partial match (for longer words)
    else if (keyword.length > 4) {
      const stem = keyword.substring(0, keyword.length - 2);
      if (contentLower.includes(stem)) {
        matchCount++;
        totalWeight += 0.5;
      }
    }
  }
  
  // Calculate score based on matches and keyword coverage
  const coverage = matchCount / keywords.length;
  const weight = totalWeight / keywords.length;
  
  return (coverage * 0.6 + weight * 0.4);
}

/**
 * Get context for a specific scene or situation
 */
export async function getSceneContext(
  campaignId: string,
  locationId: string,
  characterIds: string[]
): Promise<{
  locationContext: string;
  characterContext: string[];
  relevantHistory: string[];
}> {
  // Get location details
  const location = await locationRepository.getById(locationId);
  let locationContext = '';
  
  if (location) {
    locationContext = `**${location.name}** (${location.type})\n`;
    locationContext += location.description;
    
    if (location.pointsOfInterest && location.pointsOfInterest.length > 0) {
      locationContext += '\n\nPoints of Interest: ';
      locationContext += location.pointsOfInterest.map(p => p.name).join(', ');
    }
    
    // Get NPCs at location
    const npcs = await locationRepository.getNPCsAtLocation(locationId);
    if (npcs.length > 0) {
      locationContext += '\n\nPresent: ';
      locationContext += npcs.map(n => `${n.name} (${n.type})`).join(', ');
    }
  }
  
  // Get character contexts
  const characterContext: string[] = [];
  for (const charId of characterIds) {
    const char = await characterRepository.getById(charId);
    if (char) {
      let context = `**${char.name}** (${char.race} ${char.class} ${char.level})`;
      const hp = char.hp ?? char.hitPoints;
      if (hp) {
        context += `\nHP: ${hp.current}/${hp.max}`;
      }
      
      // Get recent memories
      const memories = await characterRepository.getRecentMemories(charId, 3);
      if (memories.length > 0) {
        context += '\nRecent: ' + memories.map(m => m.content).join('; ');
      }
      
      characterContext.push(context);
    }
  }
  
  // Get relevant history for this location
  const relevantHistory: string[] = [];
  const events = await worldRepository.getEventsAtLocation(locationId);
  for (const event of events.slice(-5)) {
    relevantHistory.push(`${event.type}: ${event.description}`);
  }
  
  return { locationContext, characterContext, relevantHistory };
}

/**
 * Store a new memory for a character
 */
export async function storeCharacterMemory(
  characterId: string,
  campaignId: string,
  content: string,
  type: string,
  importance: number,
  emotionalValence?: number,
): Promise<void> {
  await characterRepository.addMemory({
    characterId,
    campaignId,
    type,
    content,
    importance,
    emotionalValence: emotionalValence ?? 0,
    relatedEntityIds: [],
  });
}

/**
 * Update character relationships based on interactions
 */
export async function updateRelationship(
  characterId: string,
  targetId: string,
  targetType: 'pc' | 'npc',
  targetName: string,
  interaction: {
    type: 'positive' | 'negative' | 'neutral';
    description: string;
  }
): Promise<void> {
  // Ensure relationship exists
  await characterRepository.getOrCreateRelationship(
    characterId,
    targetId,
    targetType,
    targetName
  );
  
  // Calculate disposition change
  let dispositionChange = 0;
  let trustChange = 0;
  let familiarityChange = 5; // Always increase familiarity on interaction
  
  switch (interaction.type) {
    case 'positive':
      dispositionChange = 5;
      trustChange = 3;
      break;
    case 'negative':
      dispositionChange = -5;
      trustChange = -3;
      break;
    case 'neutral':
      // Just familiarity increase
      break;
  }
  
  // Update relationship
  const current = await characterRepository.getRelationships(characterId);
  const existing = current.find(r => r.targetId === targetId);
  
  if (existing) {
    await characterRepository.updateRelationship(
      characterId,
      targetId,
      {
        disposition: Math.max(0, Math.min(100, existing.disposition + dispositionChange)),
        trust: Math.max(0, Math.min(100, existing.trust + trustChange)),
        familiarity: Math.max(0, Math.min(100, existing.familiarity + familiarityChange)),
        addInteraction: interaction.description,
      }
    );
  }
}

/**
 * Build a "previously on" recap for session start
 */
export async function buildPreviouslyOn(
  campaignId: string,
  maxEvents: number = 5
): Promise<string> {
  const events = await worldRepository.getRecentImportantEvents(campaignId, maxEvents);
  
  if (events.length === 0) {
    return '';
  }
  
  let recap = '## Previously, on your adventure...\n\n';
  
  for (const event of events) {
    recap += `- ${event.description}\n`;
  }
  
  return recap;
}
