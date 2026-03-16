/**
 * Game Orchestrator
 * Coordinates the flow of the game between DM and player agents
 */

import type { AgentRuntime } from '@elizaos/core';
import type { Server as SocketIOServer } from 'socket.io';
import type { SessionState } from './session-manager';
import type { CharacterSheet, GameTime, Campaign, Monster, DamageType } from '../types';
import { 
  startSession, 
  endSession, 
  recordEvent,
  visitLocation,
  interactWithNPC,
  recordCombatEncounter,
  advanceTime,
} from './session-manager';
import {
  createEncounter,
  addPartyToEncounter,
  addMonstersToEncounter,
  startCombat,
  endTurn,
  updateCombatant,
  addLogEntry,
  shouldCombatEnd,
  endCombat,
  getCombatSummary,
  logCombatToDatabase,
  getCurrentCombatant,
  type CombatEncounter,
} from '../combat';
import {
  executeAttack,
  executeDash,
  executeDisengage,
  executeDodge,
  executeHelp,
  executeHide,
  executeReady,
  executeMovement,
  executeStandUp,
  executeDeathSave,
} from '../combat/combat-actions';
import { extractConditionNames, normalizeHP, buildCharacterPayload } from '../combat/condition-utils';
import { resolveCombatStats, findSpell, hasSpellSlot } from '../combat/stat-resolver';
import { applyHealing, rollDamage } from '../combat/damage-healing';
import { applySpellEffect } from '../combat/spell-effects';
import type { ActionResult } from '../combat/combat-actions';
import { takeShortRest, takeLongRest } from '../rules';
import { characterRepository, locationRepository } from '../persistence';
import { storeCharacterMemory } from './memory-retrieval';

export type GamePhase = 
  | 'initializing'
  | 'narration'
  | 'exploration'
  | 'social'
  | 'combat'
  | 'rest'
  | 'transition'
  | 'ending';

export interface GameState {
  phase: GamePhase;
  sessionState: SessionState | null;
  combatEncounter: CombatEncounter | null;
  dmAgent: AgentRuntime | null;
  playerAgents: Map<string, AgentRuntime>;
  pendingActions: string[];
  turnQueue: string[];
  lastUpdate: Date;
  // Internal fields set by bootstrap (underscore-prefixed to denote runtime-only)
  _io?: SocketIOServer;
  _campaign?: Campaign;
  _characters?: CharacterSheet[];
  _openingNarration?: string;
}

/**
 * Create a new game orchestrator
 */
export function createGameOrchestrator(): GameState {
  return {
    phase: 'initializing',
    sessionState: null,
    combatEncounter: null,
    dmAgent: null,
    playerAgents: new Map(),
    pendingActions: [],
    turnQueue: [],
    lastUpdate: new Date(),
  };
}

/**
 * Initialize a game session
 */
export async function initializeGame(
  state: GameState,
  campaignId: string,
  dmAgent: AgentRuntime,
  playerAgents: Map<string, AgentRuntime>
): Promise<GameState> {
  // Start the session
  const { session, state: sessionState } = await startSession(campaignId);
  
  // Set up agents
  state.dmAgent = dmAgent;
  state.playerAgents = playerAgents;
  state.sessionState = sessionState;
  state.phase = 'narration';
  state.lastUpdate = new Date();
  
  // Configure DM agent with session context
  await dmAgent.setSetting('sessionId', session.id);
  await dmAgent.setSetting('campaignId', campaignId);
  await dmAgent.setSetting('campaignState', JSON.stringify({
    currentTime: sessionState.currentTime,
    currentLocationId: sessionState.currentLocationId,
  }));
  
  // Configure player agents
  for (const [characterId, agent] of playerAgents) {
    await agent.setSetting('sessionId', session.id);
    await agent.setSetting('campaignId', campaignId);
    await agent.setSetting('characterId', characterId);
  }
  
  return state;
}

/**
 * End the current game session
 */
export async function endGame(
  state: GameState,
  notes?: string
): Promise<void> {
  if (!state.sessionState) {
    throw new Error('No active session to end');
  }
  
  state.phase = 'ending';
  
  // End any active combat
  if (state.combatEncounter && state.combatEncounter.status === 'active') {
    state.combatEncounter = endCombat(state.combatEncounter, 'Session ended');
  }
  
  // Save session
  await endSession(state.sessionState.sessionId, state.sessionState, notes);
  
  // Clean up
  state.sessionState = null;
  state.combatEncounter = null;
  state.turnQueue = [];
  state.pendingActions = [];
}

/**
 * Transition to a new game phase
 */
export async function transitionPhase(
  state: GameState,
  newPhase: GamePhase,
  context?: Record<string, unknown>
): Promise<GameState> {
  const oldPhase = state.phase;
  state.phase = newPhase;
  state.lastUpdate = new Date();
  
  // Handle phase-specific setup
  switch (newPhase) {
    case 'combat':
      if (context?.enemies && state.sessionState) {
        state.combatEncounter = await initiateCombat(state, context.enemies as unknown[]);
      }
      break;
      
    case 'exploration':
      state.turnQueue = [...state.playerAgents.keys()];
      break;
      
    case 'social':
      state.turnQueue = [...state.playerAgents.keys()];
      break;
      
    case 'rest':
      if (state.sessionState) {
        const restType = context?.restType as 'short' | 'long' || 'short';
        const restMinutes = restType === 'long' ? 480 : 60;
        advanceTime(state.sessionState, restMinutes);
      }
      break;
  }
  
  // Log phase transition
  if (state.sessionState) {
    await recordEvent(state.sessionState, {
      type: 'environmental',
      description: `Transitioned from ${oldPhase} to ${newPhase}`,
      importance: 2,
    });
  }
  
  // Broadcast phase change to all connected clients
  state._io?.emit('phase_change', { phase: newPhase });
  
  return state;
}

/**
 * Initiate combat encounter
 */
async function initiateCombat(
  state: GameState,
  enemies: unknown[]
): Promise<CombatEncounter> {
  if (!state.sessionState) {
    throw new Error('No active session');
  }
  
  // Create encounter
  let encounter = createEncounter(
    state.sessionState.campaignId,
    state.sessionState.sessionId,
    { battleMapId: undefined }
  );
  
  // Get party members
  const characters = await characterRepository.getByCampaign(
    state.sessionState.campaignId
  );
  
  // Add party to encounter
  const { encounter: withParty, rolls: partyRolls } = addPartyToEncounter(
    encounter,
    characters
  );
  encounter = withParty;
  
  // Add enemies to encounter
  const { encounter: withEnemies, rolls: enemyRolls } = addMonstersToEncounter(
    encounter,
    enemies as Parameters<typeof addMonstersToEncounter>[1]
  );
  encounter = withEnemies;
  
  // Start combat
  encounter = startCombat(encounter);
  
  // Build turn queue based on initiative
  state.turnQueue = encounter.initiativeOrder.map(c => c.id);
  
  return encounter;
}

/**
 * Process a player action
 */
export async function processPlayerAction(
  state: GameState,
  characterId: string,
  action: {
    type: string;
    description: string;
    target?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<{ success: boolean; response: string }> {
  if (!state.sessionState) {
    return { success: false, response: 'No active session' };
  }
  
  const agent = state.playerAgents.get(characterId);
  if (!agent) {
    return { success: false, response: 'Unknown character' };
  }
  
  // Record the action attempt and clean up after
  const actionKey = `${characterId}:${action.type}`;
  state.pendingActions.push(actionKey);
  
  const cleanupPending = () => {
    const idx = state.pendingActions.indexOf(actionKey);
    if (idx !== -1) state.pendingActions.splice(idx, 1);
  };
  
  // Different handling based on phase
  let result: { success: boolean; response: string };
  switch (state.phase) {
    case 'combat':
      result = await processCombatAction(state, characterId, action);
      break;
      
    case 'exploration':
    case 'social':
      result = await processNonCombatAction(state, characterId, action);
      break;
      
    case 'narration':
    case 'transition':
      // First action in narration auto-transitions to exploration
      await transitionPhase(state, 'exploration');
      result = await processNonCombatAction(state, characterId, action);
      break;
      
    case 'rest':
      // Allow messages/social actions during rest
      if (action.type === 'message' || action.type === 'social') {
        result = await processNonCombatAction(state, characterId, action);
      } else {
        result = { success: false, response: 'The party is resting. Only conversation is possible.' };
      }
      break;
      
    default:
      result = { success: false, response: 'Cannot take actions in current phase' };
      break;
  }
  
  cleanupPending();
  return result;
}

/**
 * Process an action during combat — routes to real combat-actions module
 */
async function processCombatAction(
  state: GameState,
  characterId: string,
  action: {
    type: string;
    description: string;
    target?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<{ success: boolean; response: string }> {
  if (!state.combatEncounter) {
    return { success: false, response: 'No active combat' };
  }
  
  // Check if it's this character's turn
  const currentCombatant = state.combatEncounter.initiativeOrder[
    state.combatEncounter.currentTurnIndex
  ];
  
  if (!currentCombatant || currentCombatant.sourceId !== characterId) {
    return { 
      success: false, 
      response: `It's not your turn. Current turn: ${currentCombatant?.name || 'Unknown'}` 
    };
  }
  
  // Resolve target combatant if specified
  const target = action.target
    ? state.combatEncounter.initiativeOrder.find(
        c => c.id === action.target || c.name.toLowerCase() === action.target?.toLowerCase()
      )
    : undefined;
  
  // Resolve the character's real stats for weapon/spell/skill lookups
  const sheet = state._characters?.find(c => c.id === characterId);
  const stats = sheet ? resolveCombatStats(sheet) : null;
  
  /** Apply an ActionResult to the encounter and broadcast it. */
  const apply = (result: ActionResult, endsT = true): { response: string; shouldEndTurn: boolean } => {
    for (const updated of result.updatedCombatants) {
      state.combatEncounter = updateCombatant(state.combatEncounter!, updated);
    }
    state.combatEncounter = addLogEntry(state.combatEncounter!, result.logEntry);
    broadcastCombat(state, {
      actorName: currentCombatant.name,
      description: result.description,
      damage: result.logEntry.damage?.amount,
      healing: result.logEntry.healing,
    });
    return { response: result.description, shouldEndTurn: endsT };
  };
  
  let response = '';
  let shouldEndTurn = false;
  
  switch (action.type) {
    case 'attack': {
      if (!target) return { success: false, response: 'No valid target for attack.' };
      const w = stats?.primaryWeapon;
      const result = await executeAttack(currentCombatant, target,
        (action.metadata?.attackBonus as number) ?? w?.attackBonus ?? currentCombatant.dexterityModifier + 2,
        { dice: (action.metadata?.damageDice as string) ?? w?.damageDice ?? '1d4',
          type: (action.metadata?.damageType as DamageType) ?? w?.damageType ?? 'bludgeoning' },
        { advantage: action.metadata?.advantage as boolean | undefined,
          disadvantage: action.metadata?.disadvantage as boolean | undefined,
          isMagical: action.metadata?.isMagical as boolean | undefined,
          isRanged: action.metadata?.isRanged as boolean | undefined });
      ({ response, shouldEndTurn } = apply(result));
      break;
    }
    
    case 'dash':
      ({ response, shouldEndTurn } = apply(executeDash(currentCombatant)));
      break;
    case 'dodge':
      ({ response, shouldEndTurn } = apply(executeDodge(currentCombatant)));
      break;
    case 'disengage':
      ({ response, shouldEndTurn } = apply(executeDisengage(currentCombatant)));
      break;
    case 'death_save':
      ({ response, shouldEndTurn } = apply(executeDeathSave(currentCombatant)));
      break;
    case 'ready':
      ({ response, shouldEndTurn } = apply(executeReady(
        currentCombatant,
        (action.metadata?.trigger as string) ?? action.description,
        (action.metadata?.readiedAction as string) ?? 'Attack',
      )));
      break;
    
    case 'hide': {
      const stealthMod = (action.metadata?.stealthModifier as number) ?? stats?.stealthModifier ?? 0;
      const enemies = state.combatEncounter.initiativeOrder.filter(
        c => c.type !== currentCombatant.type && c.hp.current > 0,
      );
      ({ response, shouldEndTurn } = apply(
        executeHide(currentCombatant, Math.floor(Math.random() * 20) + 1, stealthMod, enemies),
      ));
      break;
    }
    
    case 'help': {
      if (!target) return { success: false, response: 'No valid target for help.' };
      ({ response, shouldEndTurn } = apply(executeHelp(
        currentCombatant, target,
        (action.metadata?.helpType as 'attack' | 'ability_check') ?? 'attack',
      )));
      break;
    }
    
    case 'movement': {
      const dist = (action.metadata?.distance as number) ?? 5;
      ({ response, shouldEndTurn } = apply(
        executeMovement(currentCombatant, dist, action.metadata?.position as { x: number; y: number } | undefined),
        false, // movement doesn't end turn
      ));
      break;
    }
    case 'stand_up':
      ({ response, shouldEndTurn } = apply(executeStandUp(currentCombatant), false));
      break;
    
    case 'cast_spell': {
      const spellName = (action.metadata?.spellName as string) ?? action.description ?? 'a spell';
      const spell = stats ? findSpell(stats, spellName) : null;
      const spellLevel = spell?.level ?? (action.metadata?.spellLevel as number) ?? 0;
      
      if (spellLevel > 0 && stats && !hasSpellSlot(stats, spellLevel)) {
        return { success: false, response: `No spell slots remaining at level ${spellLevel}.` };
      }
      if (spellLevel > 0 && sheet?.spellSlots?.[spellLevel]) {
        sheet.spellSlots[spellLevel].current = Math.max(0, sheet.spellSlots[spellLevel].current - 1);
        state._io?.emit('character_update', buildCharacterPayload(sheet));
        // Persist spell slot change to database
        if (sheet.id) {
          await characterRepository.updateSheet(sheet.id, sheet).catch(e =>
            console.error('Failed to persist spell slots:', e.message),
          );
        }
      }
      
      if ((spell?.isAttack ?? action.metadata?.attack === true) && target) {
        const r = await executeAttack(currentCombatant, target,
          spell?.attackBonus ?? stats?.spellAttackBonus ?? currentCombatant.dexterityModifier + 2,
          { dice: spell?.damageDice ?? (action.metadata?.damageDice as string) ?? '1d8',
            type: spell?.damageType ?? (action.metadata?.damageType as DamageType) ?? 'fire' },
          { isMagical: true });
        apply(r);
        response = `${currentCombatant.name} casts ${spellName}! ${r.description}`;
      } else if ((spell?.isHealing ?? !!action.metadata?.healing) && target) {
        const healDice = spell?.healingDice ?? (action.metadata?.healingDice as string) ?? '1d8+3';
        const { total: healAmt } = rollDamage(healDice, false);
        const { combatant: healed, result: hr } = applyHealing(target, healAmt, currentCombatant.name);
        state.combatEncounter = updateCombatant(state.combatEncounter, healed);
        state.combatEncounter = addLogEntry(state.combatEncounter, {
          actorId: currentCombatant.id, actorName: currentCombatant.name,
          actionType: 'cast_spell', actionDescription: `Cast ${spellName} on ${target.name}`,
          targetIds: [target.id], targetNames: [target.name],
          healing: hr.amount, outcome: `Healed ${hr.amount} HP`,
        });
        response = `${currentCombatant.name} casts ${spellName} on ${target.name}, healing ${hr.amount} HP!`;
        broadcastCombat(state, { actorName: currentCombatant.name, description: response, healing: hr.amount });
      } else {
        // Try to apply registered spell effects (Shield, Bless, Sleep, etc.)
        const allTargets = target ? [target] : [];
        // For party-wide buffs (Bless), include all friendly combatants
        if (['bless'].includes(spellName.toLowerCase())) {
          const allies = state.combatEncounter.initiativeOrder.filter(c => c.type === currentCombatant.type && c.hp.current > 0);
          allTargets.push(...allies);
        }
        const spellResult = applySpellEffect(spellName, state.combatEncounter, currentCombatant, allTargets);
        if (spellResult) {
          state.combatEncounter = spellResult.encounter;
          response = spellResult.description;
        } else {
          response = `${currentCombatant.name} casts ${spellName}.`;
        }
        state.combatEncounter = addLogEntry(state.combatEncounter, {
          actorId: currentCombatant.id, actorName: currentCombatant.name,
          actionType: 'cast_spell', actionDescription: `Cast ${spellName}`,
          outcome: response,
        });
        broadcastCombat(state, { actorName: currentCombatant.name, description: response });
      }
      shouldEndTurn = true;
      break;
    }
    
    case 'end_turn':
      response = `${currentCombatant.name} ends their turn.`;
      shouldEndTurn = true;
      break;
    
    default:
      response = `${currentCombatant.name}: ${action.description}`;
      shouldEndTurn = true;
      state.combatEncounter = addLogEntry(state.combatEncounter, {
        actorId: currentCombatant.id, actorName: currentCombatant.name,
        actionType: 'free_action', actionDescription: action.description, outcome: 'Action performed',
      });
      broadcastCombat(state, { actorName: currentCombatant.name, description: response });
      break;
  }
  
  // End turn after main action (unless it was just movement)
  if (shouldEndTurn) {
    state.combatEncounter = endTurn(state.combatEncounter);
  }
  
  // Broadcast updated combat state
  broadcastCombatState(state);
  
  // Check for combat end
  const endCheck = shouldCombatEnd(state.combatEncounter);
  if (endCheck.shouldEnd) {
    // Calculate XP from defeated enemies
    const xp = state.combatEncounter.defeatedCombatants
      .filter(c => c.type === 'monster')
      .reduce((sum, c) => sum + (c.experiencePoints ?? 0), 0);
    
    // Log combat to database with real game time from session
    const gameTime = state.sessionState?.currentTime;
    await logCombatToDatabase(state.combatEncounter, gameTime).catch((err: Error) => {
      console.error('Failed to log combat to database:', err.message);
    });
    
    state.combatEncounter = endCombat(state.combatEncounter, endCheck.reason || 'Combat ended');
    
    const summary = getCombatSummary(state.combatEncounter);
    
    if (state.sessionState) {
      await recordCombatEncounter(
        state.sessionState,
        endCheck.winners === 'party' ? 'victory' : 'defeat',
        xp,
      );
    }
    
    // Broadcast combat end before phase transition (so client clears combat UI)
    state._io?.emit('combat_end', {});
    
    // Transition out of combat (this broadcasts phase_change internally)
    await transitionPhase(state, 'exploration');
    
    // Build end-of-combat summary
    let endMessage = '\n\n**Combat has ended!**';
    if (summary.mvp) {
      endMessage += `\nMVP: ${summary.mvp.name} (${summary.mvp.contribution})`;
    }
    if (xp > 0) {
      endMessage += `\nExperience gained: ${xp} XP`;
    }
    response += endMessage;
    
    // Store combat memory for all party members
    const cid = state.sessionState?.campaignId ?? '';
    const partyIds = state._characters?.filter(c => c.id).map(c => c.id!) ?? [];
    for (const pid of partyIds) {
    storeCharacterMemory(
      pid, cid,
      `Combat encounter: ${endCheck.reason}. ${endMessage.replace(/\n/g, ' ')}`,
      'combat', 7,
      endCheck.winners === 'party' ? 3 : -3,
    ).catch((err: Error) => console.error(`Failed to store combat memory for ${pid}:`, err.message));
    }
  }
  
  return { success: true, response };
}

/**
 * Process an action outside of combat
 */
async function processNonCombatAction(
  state: GameState,
  characterId: string,
  action: {
    type: string;
    description: string;
    target?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<{ success: boolean; response: string }> {
  // Look up character name for narration
  const character = state._characters?.find(c => c.id === characterId);
  const characterName = character?.name ?? 'Adventurer';
  
  // Record significant actions
  if (state.sessionState && action.type !== 'movement') {
    await recordEvent(state.sessionState, {
      type: action.type === 'social' ? 'social' : 'discovery',
      description: `${characterName}: ${action.description}`,
      importance: 3,
    });
  }
  
  // Handle location changes
  if (action.type === 'movement' && action.metadata?.locationId && state.sessionState) {
    await visitLocation(state.sessionState, action.metadata.locationId as string);
  }
  
  // Handle NPC interactions
  if (action.type === 'social' && action.metadata?.npcId && state.sessionState) {
    await interactWithNPC(state.sessionState, action.metadata.npcId as string);
  }
  
  // Handle rest actions with real mechanics
  if (action.type === 'rest') {
    return await processRestAction(state, characterId, action);
  }
  
  // Generate a contextual DM response based on the action type
  const response = await generateDMResponse(state, characterName, action);
  
  // Broadcast the DM's response as narration
  if (state._io) {
    state._io.emit('dm_narration', { content: response });
  }
  
  // Store a memory of significant exploration/social actions
  if (state.sessionState && action.type !== 'message' && action.type !== 'movement') {
    storeCharacterMemory(
      characterId, state.sessionState.campaignId,
      `${characterName} ${action.description}`,
      action.type === 'social' ? 'social' : 'exploration',
      3, 0,
    ).catch((err: Error) => console.error(`Failed to store memory for ${characterId}:`, err.message));
  }
  
  return { success: true, response };
}

/**
 * Process a rest action with real D&D 5e rest mechanics.
 */
async function processRestAction(
  state: GameState,
  characterId: string,
  action: { type: string; description: string; metadata?: Record<string, unknown> },
): Promise<{ success: boolean; response: string }> {
  const charSheet = state._characters?.find(c => c.id === characterId);
  if (!charSheet) {
    return { success: false, response: 'Character not found.' };
  }

  const restType = (action.metadata?.restType as string) ?? 'short';
  const hp = normalizeHP(charSheet);
  const conScore = typeof charSheet.abilities?.constitution === 'object'
    ? (charSheet.abilities.constitution as { score: number }).score
    : ((charSheet.abilities?.constitution as number) ?? 10);

  // Normalize for rest functions which expect hitPoints + abilities.constitution as number
  const normalizedSheet = {
    ...charSheet,
    hitPoints: { current: hp.current, max: hp.max, temporary: hp.temp },
    abilities: { ...charSheet.abilities, constitution: conScore },
  };

  let response: string;

  if (restType === 'long') {
    const result = takeLongRest({ character: normalizedSheet as Parameters<typeof takeLongRest>[0]['character'] });
    
    if (result.wasSuccessful) {
      if (charSheet.hp) charSheet.hp.current = result.newCurrentHP;
      if (charSheet.hitPoints) charSheet.hitPoints.current = result.newCurrentHP;
      if (charSheet.hitDice) charSheet.hitDice.current = result.newHitDiceRemaining;
      if (result.spellSlotsRestored && charSheet.spellSlots) {
        for (const [level, slot] of Object.entries(charSheet.spellSlots)) {
          charSheet.spellSlots[Number(level)] = { ...slot, current: slot.max };
        }
      }
      // Persist full sheet (HP + hit dice + spell slots) to database
      if (charSheet.id) {
        await characterRepository.updateSheet(charSheet.id, charSheet);
      }
    }
    response = result.description;
    if (state.sessionState) advanceTime(state.sessionState, 480);
  } else {
    const availableHitDice = charSheet.hitDice?.current ?? charSheet.level;
    const hitDiceToSpend = Math.max(1, Math.ceil(availableHitDice / 2));
    
    const result = takeShortRest({
      character: normalizedSheet as Parameters<typeof takeShortRest>[0]['character'],
      hitDiceToSpend,
    });
    
    if (charSheet.hp) charSheet.hp.current = result.newCurrentHP;
    if (charSheet.hitPoints) charSheet.hitPoints.current = result.newCurrentHP;
    if (charSheet.hitDice) charSheet.hitDice.current = result.newHitDiceRemaining;
    // Persist full sheet (HP + hit dice) to database
    if (charSheet.id) {
      await characterRepository.updateSheet(charSheet.id, charSheet);
    }
    response = result.description;
    if (state.sessionState) advanceTime(state.sessionState, 60);
  }

  // Broadcast rest results and updated character data
  state._io?.emit('dm_narration', { content: response });
  state._io?.emit('character_update', buildCharacterPayload(charSheet));

  return { success: true, response };
}

/**
 * Generate a DM response to a player action.
 * If the DM agent is a real AgentRuntime with an LLM, generates via AI.
 * Otherwise falls back to context-aware templates.
 */
async function generateDMResponse(
  state: GameState,
  characterName: string,
  action: { type: string; description: string; target?: string; metadata?: Record<string, unknown> }
): Promise<string> {
  // Build game context for the prompt
  const context = await buildGameContext(state, characterName);

  // If the DM agent has generateText (real AgentRuntime), use it
  if (state.dmAgent && typeof (state.dmAgent as unknown as Record<string, unknown>).generateText === 'function') {
    const prompt = buildDMPrompt(context, characterName, action);
    const result = await (state.dmAgent as unknown as { generateText: (input: string, opts?: Record<string, unknown>) => Promise<{ text: string }> })
      .generateText(prompt, { maxTokens: 300, temperature: 0.8 });
    return result.text;
  }

  // Fallback: template-based response using real game data
  return buildTemplateResponse(context, characterName, action);
}

interface GameContext {
  locationName: string;
  locationDesc: string;
  timeOfDay: string;
  partyStatus: string;
  recentEvents: string[];
  campaignName: string;
}

async function buildGameContext(state: GameState, _characterName: string): Promise<GameContext> {
  let locationName = 'the area';
  let locationDesc = '';
  const locationId = state.sessionState?.currentLocationId;
  if (locationId) {
    const location = await locationRepository.getById(locationId);
    if (location) {
      locationName = location.name;
      locationDesc = location.description;
    }
  }

  const time = state.sessionState?.currentTime;
  const hour = time?.hour ?? 12;
  const timeOfDay = hour >= 5 && hour < 8 ? 'early morning'
    : hour < 12 ? 'morning' : hour < 14 ? 'midday'
    : hour < 17 ? 'afternoon' : hour < 20 ? 'evening'
    : hour < 23 ? 'night' : 'late night';

  const chars = state._characters ?? [];
  const partyStatus = chars.map(c => {
    const hp = c.hp ?? c.hitPoints;
    return `${c.name} (L${c.level} ${c.race} ${c.class}, ${hp?.current ?? '?'}/${hp?.max ?? '?'} HP)`;
  }).join(', ');

  return {
    locationName,
    locationDesc,
    timeOfDay,
    partyStatus,
    recentEvents: state.sessionState?.recentEvents?.slice(-5) ?? [],
    campaignName: state._campaign?.name ?? 'the campaign',
  };
}

function buildDMPrompt(ctx: GameContext, characterName: string, action: { type: string; description: string }): string {
  let prompt = `You are the Dungeon Master. Respond to the player's action in character.\n\n`;
  prompt += `## Current Scene\n`;
  prompt += `Location: ${ctx.locationName}\n`;
  if (ctx.locationDesc) prompt += `${ctx.locationDesc}\n`;
  prompt += `Time: ${ctx.timeOfDay}\n`;
  prompt += `Party: ${ctx.partyStatus}\n`;
  if (ctx.recentEvents.length > 0) {
    prompt += `\nRecent events:\n${ctx.recentEvents.map(e => `- ${e}`).join('\n')}\n`;
  }
  prompt += `\n## Player Action\n`;
  prompt += `${characterName}: "${action.description}"\n`;
  prompt += `Action type: ${action.type}\n`;
  prompt += `\nRespond as the DM. Be vivid, concise (2-4 sentences), and advance the story. `;
  prompt += `If the action requires a skill check, tell the player what to roll. `;
  prompt += `Stay consistent with the location and situation.`;
  return prompt;
}

function buildTemplateResponse(
  ctx: GameContext, characterName: string,
  action: { type: string; description: string },
): string {
  switch (action.type) {
    case 'explore':
    case 'investigate':
      return ctx.locationDesc
        ? `${characterName} searches ${ctx.locationName}. ${ctx.locationDesc.split('.')[0]}. The ${ctx.timeOfDay} air is still as they look for anything of note.`
        : `${characterName} carefully investigates ${ctx.locationName}.`;
    case 'use_item':
      return `${characterName} reaches into their pack. ${action.description}.`;
    case 'social':
    case 'interact_with_npc':
      return `${characterName} engages in conversation in ${ctx.locationName}. ${action.description}.`;
    case 'movement':
      return `${characterName} moves through ${ctx.locationName}.`;
    case 'message':
      return `The Dungeon Master considers ${characterName}'s words. You are in ${ctx.locationName} during the ${ctx.timeOfDay}. ${ctx.locationDesc ? ctx.locationDesc.split('.')[0] + '.' : 'The area stretches before you.'} What would you like to do?`;
    default:
      return `${characterName}: ${action.description}`;
  }
}

/**
 * Get the current game status
 */
export function getGameStatus(state: GameState): {
  phase: GamePhase;
  inCombat: boolean;
  currentTurn: string | null;
  roundNumber: number;
  sessionDuration: number;
} {
  const inCombat = state.phase === 'combat' && state.combatEncounter !== null;
  
  let currentTurn: string | null = null;
  let roundNumber = 0;
  
  if (inCombat && state.combatEncounter) {
    const current = state.combatEncounter.initiativeOrder[
      state.combatEncounter.currentTurnIndex
    ];
    currentTurn = current?.name || null;
    roundNumber = state.combatEncounter.round;
  }
  
  const sessionDuration = state.sessionState
    ? Math.round((new Date().getTime() - state.sessionState.startedAt.getTime()) / 60000)
    : 0;
  
  return {
    phase: state.phase,
    inCombat,
    currentTurn,
    roundNumber,
    sessionDuration,
  };
}

/**
 * Broadcast a message to all player agents and connected clients
 */
export async function broadcastToPlayers(
  state: GameState,
  message: string,
  excludeIds?: string[]
): Promise<void> {
  const excludeSet = new Set(excludeIds || []);
  
  // Broadcast to agent runtimes
  for (const [characterId, agent] of state.playerAgents) {
    if (!excludeSet.has(characterId)) {
      (agent as unknown as { emit: (event: string, data: unknown) => void }).emit('dm_message', {
        content: message,
        timestamp: new Date(),
      });
    }
  }
  
  // Broadcast to connected WebSocket clients
  if (state._io) {
    state._io.emit('dm_narration', { content: message });
  }
}

// ============================================================================
// INTERNAL BROADCAST HELPERS
// ============================================================================

/** Broadcast a combat action event to all connected clients */
function broadcastCombat(
  state: GameState,
  action: { actorName: string; description: string; damage?: number; healing?: number }
): void {
  state._io?.emit('combat_action', action);
}

/** Broadcast the current combat state to all connected clients */
function broadcastCombatState(state: GameState): void {
  const combat = state.combatEncounter;
  if (!combat || !state._io) return;

  state._io.emit('combat_update', {
    round: combat.round,
    currentTurnIndex: combat.currentTurnIndex,
    combatants: combat.initiativeOrder.map((c, i) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      initiative: c.initiative,
      hp: c.hp,
      ac: c.ac,
      conditions: extractConditionNames(c.conditions),
      isCurrentTurn: i === combat.currentTurnIndex,
    })),
  });
}
