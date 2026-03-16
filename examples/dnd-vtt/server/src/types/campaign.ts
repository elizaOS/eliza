/**
 * Campaign Persistence Types
 * Multi-session campaign state and history
 */

import type { CharacterSheet } from './character';
import type { NPC, Monster } from './monster';
import type { CombatState, CombatLogEntry } from './combat';

// ============================================================================
// GAME TIME
// ============================================================================

export interface GameTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export interface GameDate {
  year: number;
  month: number;
  day: number;
}

// ============================================================================
// CAMPAIGN
// ============================================================================

export interface CampaignSettings {
  maxPartySize: number;
  startingLevel: number;
  allowPvP: boolean;
  deathRules: 'standard' | 'heroic' | 'gritty';
  restRules: 'standard' | 'gritty' | 'epic';
  encumbranceRules: 'none' | 'standard' | 'variant';
}

export interface Campaign {
  id?: string;
  name: string;
  description: string;
  
  // DM
  dmAgentId?: string;
  dmCharacterName?: string;
  
  // Settings
  settings?: CampaignSettings;
  setting?: string; // Simple setting description
  tone?: string;
  themes?: string[];
  
  // World State
  currentTime?: GameTime;
  currentLocationId?: string;
  startingLocationId?: string;
  
  // Status
  status?: 'active' | 'paused' | 'completed';
  
  // Metadata
  createdAt?: Date;
  updatedAt?: Date;
  totalPlayTime?: number; // In minutes
  sessionCount?: number;
}

// ============================================================================
// SESSION
// ============================================================================

export interface SessionSummary {
  overview: string;
  keyEvents: string[];
  npcInteractions: { npcId: string; npcName: string; summary: string }[];
  combatsResolved: number;
  xpGained: number;
  goldGained: number;
  itemsFound: string[];
  questsUpdated: { questId: string; questName: string; update: string }[];
  cliffhanger?: string;
}

export interface Session {
  id: string;
  campaignId: string;
  sessionNumber: number;
  
  // Timing
  startedAt: Date;
  endedAt?: Date;
  duration?: number; // Minutes
  
  // State
  startingLocationId: string;
  endingLocationId?: string;
  startingTime: GameTime;
  endingTime?: GameTime;
  
  // Summary (AI-generated)
  summary?: SessionSummary;
  
  // Snapshot for restoration
  stateSnapshot?: string; // JSON stringified game state
  
  // Participants
  playerCharacterIds: string[];
  activeNpcIds: string[];
}

// ============================================================================
// LOCATIONS
// ============================================================================

export type LocationType =
  | 'town'
  | 'city'
  | 'village'
  | 'dungeon'
  | 'cave'
  | 'forest'
  | 'mountain'
  | 'plains'
  | 'swamp'
  | 'desert'
  | 'coast'
  | 'underwater'
  | 'building'
  | 'temple'
  | 'castle'
  | 'ruins'
  | 'other';

export type TerrainType =
  | 'normal'
  | 'difficult'
  | 'water_shallow'
  | 'water_deep'
  | 'lava'
  | 'ice'
  | 'void'
  | 'wall'
  | 'pit';

export interface LocationConnection {
  targetLocationId: string;
  direction: string;
  description: string;
  travelTime?: number; // In hours
  requiredKey?: string;
  hidden: boolean;
  dcToFind?: number;
}

export interface LocationFeature {
  name: string;
  description: string;
  interactable: boolean;
  dcToInteract?: number;
  effect?: string;
}

export interface Location {
  id?: string;
  campaignId?: string;
  
  // Identity
  name: string;
  description: string;
  type: LocationType | string;
  
  // Hierarchy
  parentLocationId?: string;
  
  // Tags and metadata
  tags?: string[];
  npcs?: string[];
  pointsOfInterest?: Array<{ name: string; description: string }>;
  availableServices?: string[];
  dangerLevel?: number; // 0-10
  
  // Visit tracking
  isDiscovered?: boolean;
  visitCount?: number;
  lastVisited?: Date;
  
  // Visual
  imageUrl?: string;
}

// ============================================================================
// BATTLE MAPS
// ============================================================================

export interface BattleMapCell {
  terrain: TerrainType;
  elevation: number;
  cover: 'none' | 'half' | 'three_quarters' | 'full';
  notes?: string;
}

export interface BattleMap {
  id: string;
  locationId: string;
  campaignId: string;
  name: string;
  
  // Dimensions
  gridWidth: number;
  gridHeight: number;
  gridSize: number; // Feet per grid square
  
  // Background
  backgroundUrl?: string;
  
  // Grid Data
  gridData: Record<string, BattleMapCell>;
  
  // Fog of War
  fogOfWar: Array<{ x: number; y: number; revealed: boolean }>;
  
  // Markers
  markers: Array<{ x: number; y: number; label: string; color: string }>;
}

// ============================================================================
// WORLD EVENTS
// ============================================================================

export type WorldEventType =
  | 'combat_start'
  | 'combat_end'
  | 'death'
  | 'discovery'
  | 'dialogue'
  | 'quest_start'
  | 'quest_complete'
  | 'quest_fail'
  | 'item_found'
  | 'item_used'
  | 'level_up'
  | 'travel'
  | 'rest'
  | 'skill_check'
  | 'npc_interaction'
  | 'story_moment'
  | 'party_decision'
  | 'other';

export interface WorldEvent {
  id: string;
  campaignId: string;
  sessionId: string;
  
  // Type and description
  type: WorldEventType;
  description: string;
  
  // Location and time
  gameTime: GameTime;
  locationId?: string;
  
  // Involved entities
  involvedEntityIds: string[];
  consequences: string[];
  
  // Importance for memory retrieval (1-10)
  importance: number;
  
  // Created time
  createdAt: Date;
  
  // Embedding for semantic search (stored separately)
  embeddingId?: string;
}

// ============================================================================
// QUESTS
// ============================================================================

export type QuestStatus = 'available' | 'active' | 'completed' | 'failed';

export interface QuestObjective {
  id: string;
  description: string;
  isComplete?: boolean;
  completed?: boolean; // Alias for isComplete
  completedAt?: Date;
}

export interface Quest {
  id?: string;
  campaignId?: string;
  
  // Identity
  name: string;
  description: string;
  type: 'main' | 'side' | 'personal' | 'faction';
  
  // Giver
  giver?: string;
  locationId?: string;
  
  // Objectives
  objectives: QuestObjective[];
  
  // Rewards
  rewards?: {
    experience?: number;
    gold?: number;
    items?: string[];
  };
  
  // State
  status?: QuestStatus;
  importance?: number; // 1-10
  
  // Timeline
  acceptedAt?: Date;
  completedAt?: Date;
}

// ============================================================================
// CHARACTER MEMORY
// ============================================================================

export interface CharacterMemory {
  id: string;
  characterId: string;
  campaignId: string;
  
  // Memory content
  type: 'experience' | 'relationship' | 'knowledge' | 'trauma' | 'triumph' | 'secret';
  content: string;
  
  // Context
  sessionId: string;
  gameTime: GameTime;
  locationId?: string;
  relatedEntityIds: string[];
  
  // Importance for retrieval
  importance: number;
  emotionalValence: number; // -1 (negative) to 1 (positive)
  
  // Metadata
  createdAt: Date;
  embeddingId?: string;
}

export interface CharacterRelationship {
  id: string;
  characterId: string;
  targetId: string;
  targetType: 'pc' | 'npc';
  targetName: string;
  
  // Relationship details
  disposition: number; // -100 to 100
  trust: number; // 0 to 100
  familiarity: number; // 0 to 100
  
  // History
  significantInteractions: string[];
  
  // Last updated
  updatedAt: Date;
}

// ============================================================================
// NPC MEMORY
// ============================================================================

export interface NPCMemory {
  id: string;
  npcId: string;
  campaignId: string;
  
  // Who was involved
  involvedCharacterIds: string[];
  involvedCharacterNames: string[];
  
  // What happened
  content: string;
  
  // Context
  sessionId: string;
  gameTime: GameTime;
  locationId: string;
  
  // Impact on NPC
  dispositionChange: Record<string, number>; // Character ID -> change
  
  // Metadata
  createdAt: Date;
}

// ============================================================================
// GAME STATE
// ============================================================================

export type GamePhase = 'exploration' | 'social' | 'combat' | 'rest' | 'travel' | 'cutscene';

export interface GameState {
  id: string;
  campaignId: string;
  sessionId: string;
  
  // Phase
  phase: GamePhase;
  phaseStartTime: Date;
  
  // Location
  currentLocationId: string;
  currentMapId?: string;
  
  // Party
  partyCharacterIds: string[];
  partyPositions: Map<string, { x: number; y: number }>;
  marchingOrder?: string[]; // Character IDs in order
  
  // Time
  gameTime: GameTime;
  
  // Combat (when phase === 'combat')
  combatState?: CombatState;
  
  // Active effects
  activeEffects: {
    id: string;
    name: string;
    description: string;
    affectedIds: string[];
    duration?: number; // Rounds or hours
    endCondition?: string;
  }[];
  
  // Environment
  weather?: string;
  lighting: 'bright' | 'dim' | 'dark';
  
  // Flags
  flags: Map<string, boolean | string | number>;
  
  // Last update
  updatedAt: Date;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Format game time for display
 */
export function formatGameTime(time: GameTime): string {
  const hour = time.hour.toString().padStart(2, '0');
  const minute = time.minute.toString().padStart(2, '0');
  return `Day ${time.day}, ${hour}:${minute}`;
}

/**
 * Advance game time
 */
export function advanceGameTime(time: GameTime, minutes: number): GameTime {
  let totalMinutes = time.minute + minutes;
  let totalHours = time.hour + Math.floor(totalMinutes / 60);
  totalMinutes = totalMinutes % 60;
  let totalDays = time.day + Math.floor(totalHours / 24);
  totalHours = totalHours % 24;
  
  // Simple month/year handling (30 day months, 12 months)
  let totalMonths = time.month + Math.floor((totalDays - 1) / 30);
  totalDays = ((totalDays - 1) % 30) + 1;
  let totalYears = time.year + Math.floor((totalMonths - 1) / 12);
  totalMonths = ((totalMonths - 1) % 12) + 1;
  
  return {
    year: totalYears,
    month: totalMonths,
    day: totalDays,
    hour: totalHours,
    minute: totalMinutes,
  };
}

/**
 * Calculate time difference in minutes
 */
export function getTimeDifferenceMinutes(start: GameTime, end: GameTime): number {
  const startMinutes = 
    start.year * 12 * 30 * 24 * 60 +
    start.month * 30 * 24 * 60 +
    start.day * 24 * 60 +
    start.hour * 60 +
    start.minute;
  
  const endMinutes = 
    end.year * 12 * 30 * 24 * 60 +
    end.month * 30 * 24 * 60 +
    end.day * 24 * 60 +
    end.hour * 60 +
    end.minute;
  
  return endMinutes - startMinutes;
}

/**
 * Get time of day description
 */
export function getTimeOfDay(hour: number): string {
  if (hour >= 5 && hour < 7) return 'dawn';
  if (hour >= 7 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 14) return 'midday';
  if (hour >= 14 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 20) return 'evening';
  if (hour >= 20 && hour < 22) return 'dusk';
  return 'night';
}
