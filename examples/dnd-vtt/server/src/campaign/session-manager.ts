/**
 * Session Manager
 * Handles game session lifecycle and state management
 */

import { v4 as uuid } from 'uuid';
import type { 
  Campaign, 
  Session, 
  GameTime, 
  SessionSummary,
  CharacterSheet,
} from '../types';
import { 
  campaignRepository, 
  characterRepository, 
  worldRepository,
  locationRepository,
} from '../persistence';

export interface SessionState {
  sessionId: string;
  campaignId: string;
  startedAt: Date;
  currentTime: GameTime;
  currentLocationId: string | undefined;
  partyMembers: string[];
  activeQuests: string[];
  recentEvents: string[];
  combatEncounters: number;
  npcsInteracted: string[];
  locationsVisited: string[];
  lootGained: string[];
  experienceGained: number;
}

/**
 * Start a new game session
 */
export async function startSession(
  campaignId: string,
  options?: {
    startingLocationId?: string;
    startingTime?: GameTime;
  }
): Promise<{ session: Session; state: SessionState }> {
  // Get campaign
  const campaign = await campaignRepository.getById(campaignId);
  if (!campaign) {
    throw new Error(`Campaign ${campaignId} not found`);
  }
  
  // Get previous session for continuity
  const previousSession = await campaignRepository.getLatestSession(campaignId);
  
  // Determine starting state
  const startingLocationId = options?.startingLocationId || 
    previousSession?.endingLocationId ||
    campaign.startingLocationId;
  
  const startingTime: GameTime = options?.startingTime || 
    previousSession?.endingTime || {
      year: 1490,
      month: 1,
      day: 1,
      hour: 8,
      minute: 0,
    };
  
  // Create the session in database
  const session = await campaignRepository.createSession(
    campaignId,
    startingLocationId,
    startingTime
  );
  
  // Initialize session state
  const state: SessionState = {
    sessionId: session.id,
    campaignId,
    startedAt: session.startedAt,
    currentTime: startingTime,
    currentLocationId: startingLocationId || undefined,
    partyMembers: [],
    activeQuests: [],
    recentEvents: [],
    combatEncounters: 0,
    npcsInteracted: [],
    locationsVisited: startingLocationId ? [startingLocationId] : [],
    lootGained: [],
    experienceGained: 0,
  };
  
  // Load party members
  const characters = await characterRepository.getByCampaign(campaignId);
  state.partyMembers = characters.map(c => c.id).filter((id): id is string => !!id);
  
  // Load active quests
  const quests = await worldRepository.getActiveQuests(campaignId);
  state.activeQuests = quests.map(q => q.id).filter((id): id is string => !!id);
  
  // Mark starting location as visited
  if (startingLocationId) {
    await locationRepository.recordVisit(startingLocationId);
  }
  
  // Increment campaign session count
  await campaignRepository.incrementSessionCount(campaignId);
  
  return { session, state };
}

/**
 * End a game session and generate summary
 */
export async function endSession(
  sessionId: string,
  state: SessionState,
  manualNotes?: string
): Promise<Session> {
  // Calculate session duration
  const duration = Math.round(
    (new Date().getTime() - state.startedAt.getTime()) / 60000
  );
  
  // Generate session summary
  const summary = await generateSessionSummary(state, manualNotes);
  
  // End the session in database
  const session = await campaignRepository.endSession(
    sessionId,
    state.currentLocationId,
    state.currentTime,
    summary
  );
  
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }
  
  // Update campaign play time
  await campaignRepository.addPlayTime(state.campaignId, duration);
  
  // Create snapshot of current state
  await saveStateSnapshot(sessionId, state);
  
  return session;
}

/**
 * Generate a summary of the session
 */
async function generateSessionSummary(
  state: SessionState,
  manualNotes?: string
): Promise<SessionSummary> {
  // Get location names
  const locationNames: string[] = [];
  for (const locId of state.locationsVisited) {
    const location = await locationRepository.getById(locId);
    if (location) {
      locationNames.push(location.name);
    }
  }
  
  // Get NPC names
  const npcNames: string[] = [];
  for (const npcId of state.npcsInteracted) {
    const npc = await locationRepository.getNPCById(npcId);
    if (npc) {
      npcNames.push(npc.name);
    }
  }
  
  // Compile key events
  const keyEvents = state.recentEvents.slice(-10);
  
  // Build summary
  const summary: SessionSummary = {
    overview: manualNotes || `Session with ${keyEvents.length} key events across ${locationNames.length} locations`,
    keyEvents,
    npcInteractions: npcNames.map(name => ({ npcId: '', npcName: name, summary: '' })),
    combatsResolved: state.combatEncounters,
    xpGained: state.experienceGained,
    goldGained: 0,
    itemsFound: state.lootGained,
    questsUpdated: [],
    cliffhanger: keyEvents[keyEvents.length - 1] || undefined,
  };
  
  return summary;
}

/**
 * Save a snapshot of current state for recovery
 */
async function saveStateSnapshot(
  sessionId: string,
  state: SessionState
): Promise<void> {
  const snapshot = JSON.stringify({
    ...state,
    snapshotTime: new Date().toISOString(),
  });
  
  await campaignRepository.saveStateSnapshot(sessionId, snapshot);
}

/**
 * Restore state from a session snapshot
 */
export async function restoreFromSnapshot(
  sessionId: string
): Promise<SessionState | null> {
  const session = await campaignRepository.getSessionById(sessionId);
  
  if (!session?.stateSnapshot) {
    return null;
  }
  
  try {
    const state = JSON.parse(session.stateSnapshot) as SessionState;
    // Convert dates back from ISO strings
    state.startedAt = new Date(state.startedAt);
    return state;
  } catch (error) {
    console.error('Error parsing state snapshot:', error);
    return null;
  }
}

/**
 * Record an event during the session
 */
export async function recordEvent(
  state: SessionState,
  event: {
    type: string;
    description: string;
    importance: number;
    locationId?: string;
    involvedEntityIds?: string[];
  }
): Promise<void> {
  // Add to recent events
  state.recentEvents.push(event.description);
  
  // Keep recent events manageable
  if (state.recentEvents.length > 50) {
    state.recentEvents = state.recentEvents.slice(-50);
  }
  
  // Store in database for important events
  if (event.importance >= 3) {
    await worldRepository.createEvent({
      campaignId: state.campaignId,
      sessionId: state.sessionId,
      type: event.type as 'combat' | 'discovery' | 'social' | 'quest' | 'death' | 'level_up' | 'major_decision' | 'environmental',
      description: event.description,
      gameTime: state.currentTime,
      locationId: event.locationId || state.currentLocationId || undefined,
      involvedEntityIds: event.involvedEntityIds || [],
      consequences: [],
      importance: event.importance,
    });
  }
}

/**
 * Record visiting a location
 */
export async function visitLocation(
  state: SessionState,
  locationId: string
): Promise<void> {
  if (!state.locationsVisited.includes(locationId)) {
    state.locationsVisited.push(locationId);
  }
  
  state.currentLocationId = locationId;
  
  await locationRepository.recordVisit(locationId);
}

/**
 * Record interacting with an NPC
 */
export async function interactWithNPC(
  state: SessionState,
  npcId: string
): Promise<void> {
  if (!state.npcsInteracted.includes(npcId)) {
    state.npcsInteracted.push(npcId);
  }
  
  await locationRepository.recordInteraction(npcId);
}

/**
 * Record a combat encounter
 */
export async function recordCombatEncounter(
  state: SessionState,
  outcome: 'victory' | 'defeat' | 'fled' | 'truce',
  experienceGained: number
): Promise<void> {
  state.combatEncounters++;
  state.experienceGained += experienceGained;
  
  await recordEvent(state, {
    type: 'combat',
    description: `Combat encounter: ${outcome}`,
    importance: 5,
  });
}

/**
 * Record loot gained
 */
export function recordLoot(
  state: SessionState,
  items: string[]
): void {
  state.lootGained.push(...items);
}

/**
 * Advance in-game time
 */
export function advanceTime(
  state: SessionState,
  minutes: number
): void {
  let totalMinutes = state.currentTime.minute + minutes;
  let hours = state.currentTime.hour + Math.floor(totalMinutes / 60);
  totalMinutes = totalMinutes % 60;
  
  let days = state.currentTime.day + Math.floor(hours / 24);
  hours = hours % 24;
  
  // Simple month handling (30 days per month)
  let months = state.currentTime.month + Math.floor((days - 1) / 30);
  days = ((days - 1) % 30) + 1;
  
  let years = state.currentTime.year + Math.floor((months - 1) / 12);
  months = ((months - 1) % 12) + 1;
  
  state.currentTime = {
    year: years,
    month: months,
    day: days,
    hour: hours,
    minute: totalMinutes,
  };
}

/**
 * Get session recap for continuing play
 */
export async function getSessionRecap(campaignId: string): Promise<string> {
  const previousSession = await campaignRepository.getLatestSession(campaignId);
  
  if (!previousSession?.summary) {
    return 'This is the beginning of your adventure...';
  }
  
  const summary = previousSession.summary;
  
  let recap = `## Last Session Recap\n\n`;
  
  if (summary.keyEvents.length > 0) {
    recap += `**Key Events:**\n`;
    for (const event of summary.keyEvents.slice(-5)) {
      recap += `- ${event}\n`;
    }
    recap += '\n';
  }
  
  if (summary.npcInteractions.length > 0) {
    recap += `**NPCs Encountered:** ${summary.npcInteractions.map(n => n.npcName).join(', ')}\n\n`;
  }
  
  if (summary.cliffhanger) {
    recap += `**Where We Left Off:**\n${summary.cliffhanger}\n`;
  }
  
  return recap;
}
