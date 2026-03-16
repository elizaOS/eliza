/**
 * Start Combat Action
 * Initiates combat encounters
 */

import type { 
  Action, 
  IAgentRuntime, 
  Memory, 
  State, 
  HandlerCallback 
} from '@elizaos/core';
import type { Monster, CharacterSheet, CombatState, Combatant, CombatantType } from '../../../types';
import { executeDiceRoll, calculateModifier, getAC, getHP, getAbilityScore, createFreshTurnResources } from '../../../types';
import { SRD_MONSTERS, cloneMonster } from '../../../data';
import { v4 as uuid } from 'uuid';

export interface StartCombatParams {
  enemies: Array<{
    monsterId: string;
    name?: string;
    position?: { x: number; y: number };
  }>;
  surpriseRound?: {
    surprisedSide: 'party' | 'enemies' | 'none';
  };
  environmentDescription?: string;
  battleMapId?: string;
}

export const startCombatAction: Action = {
  name: 'START_COMBAT',
  description: 'Initialize a combat encounter with enemies',
  
  similes: [
    'roll initiative',
    'combat begins',
    'enemies attack',
    'start the fight',
    'battle commences',
  ],
  
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Three goblins burst from the underbrush!',
          action: 'START_COMBAT',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: '⚔️ **COMBAT BEGINS!** ⚔️\n\nThree goblins crash through the underbrush, their yellow eyes gleaming with malice as they raise rusty scimitars!\n\n**Initiative Order:**\n1. Goblin 1 - 18\n2. Thoric (Fighter) - 15\n3. Goblin 2 - 14\n4. Elara (Cleric) - 12\n5. Goblin 3 - 10\n6. Vex (Rogue) - 8\n\nThe goblins got the jump on you! Goblin 1 acts first.\n\n*Round 1 begins.*',
        },
      },
    ],
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const role = await runtime.getSetting('role');
    if (role !== 'dm') return false;
    
    // Check we're not already in combat
    const combatStateRaw = await runtime.getSetting('combatState');
    if (!combatStateRaw || typeof combatStateRaw !== 'string') return true;
    try {
      const combatState = JSON.parse(combatStateRaw) as { isActive?: boolean };
      return !combatState.isActive;
    } catch {
      return true;
    }
  },
  
  handler: async (
    runtime,
    message,
    state,
    options,
    callback
  ) => {
    const params = options as unknown as StartCombatParams;
    
    // Get party members
    const partyMembers = await getPartyMembers(runtime as IAgentRuntime);
    
    // Get enemy monsters
    const enemies = await getEnemyMonsters(runtime as IAgentRuntime, params.enemies);
    
    // Roll initiative for everyone
    const initiatives = await rollAllInitiatives(partyMembers, enemies);
    
    // Sort by initiative (highest first)
    const sortedInitiatives = initiatives.sort((a, b) => {
      if (b.initiative !== a.initiative) return b.initiative - a.initiative;
      // Tie-breaker: higher DEX goes first
      return b.dexMod - a.dexMod;
    });
    
    // Get campaign context from settings
    const campaignId = String(await (runtime as IAgentRuntime).getSetting('campaignId') ?? '');
    const sessionId = String(await (runtime as IAgentRuntime).getSetting('sessionId') ?? '');
    const locationId = String(await (runtime as IAgentRuntime).getSetting('locationId') ?? '');
    
    // Create combat state
    const combatState: CombatState = {
      id: uuid(),
      campaignId,
      sessionId,
      locationId,
      isActive: true,
      round: 1,
      currentTurnIndex: 0,
      initiativeOrder: sortedInitiatives.map((i) => ({
        id: uuid(),
        entityId: i.id,
        entityType: i.type,
        name: i.name,
        initiative: i.initiative,
        dexterity: i.dexMod,
        hasActed: false,
        isDelaying: false,
      })),
      combatants: createCombatants(partyMembers, enemies, sortedInitiatives),
      startTime: new Date(),
      rounds: [],
      readiedActions: [],
    };
    
    // Apply surprise if applicable
    if (params.surpriseRound && params.surpriseRound.surprisedSide !== 'none') {
      // Surprised creatures skip their first turn
      for (const entry of combatState.initiativeOrder) {
        const isSurprised = 
          (params.surpriseRound.surprisedSide === 'party' && entry.entityType === 'pc') ||
          (params.surpriseRound.surprisedSide === 'enemies' && entry.entityType === 'monster');
        
        if (isSurprised) {
          entry.hasActed = true; // They "acted" by being surprised
        }
      }
    }
    
    // Save combat state
    await (runtime as IAgentRuntime).setSetting('combatState', JSON.stringify(combatState));
    
    // Generate combat start narrative
    const narrative = await generateCombatStartNarrative(
      runtime as IAgentRuntime,
      state,
      enemies,
      sortedInitiatives,
      params.environmentDescription,
      params.surpriseRound
    );
    
    if (callback) {
      await callback({
        text: narrative,
        type: 'combat_start',
        metadata: {
          combatId: combatState.id,
          round: 1,
          initiativeOrder: sortedInitiatives.map(i => ({
            name: i.name,
            initiative: i.initiative,
          })),
          currentTurn: sortedInitiatives[0]?.name,
        },
      });
    }
    
    // Emit combat started event
    const combatStartPayload = {
      runtime: runtime as IAgentRuntime,
      source: 'dm-agent',
      combatId: combatState.id,
      enemies: enemies.map(e => ({ id: e.id, name: e.name })),
      initiativeOrder: sortedInitiatives,
      timestamp: new Date(),
    };
    await (runtime as IAgentRuntime).emitEvent('combat_started', combatStartPayload);
    
    return undefined;
  },
};

async function getPartyMembers(runtime: IAgentRuntime): Promise<CharacterSheet[]> {
  const campaignStateRaw = await runtime.getSetting('campaignState');
  if (campaignStateRaw && typeof campaignStateRaw === 'string') {
    try {
      const state = JSON.parse(campaignStateRaw) as { partyMembers?: CharacterSheet[] };
      return state.partyMembers || [];
    } catch {
      return [];
    }
  }
  return [];
}

async function getEnemyMonsters(
  _runtime: IAgentRuntime,
  enemyDefs: StartCombatParams['enemies']
): Promise<Monster[]> {
  const monsters: Monster[] = [];
  
  for (const def of enemyDefs) {
    // Look up monster by ID in SRD data (normalize: "goblin", "srd-goblin", "Goblin" all match)
    const key = def.monsterId
      .toLowerCase()
      .replace(/^srd-/, '')
      .replace(/\s+/g, '_');
    
    const template = SRD_MONSTERS[key];
    
    if (template) {
      // Clone the template so each instance has unique state
      const monster = cloneMonster(template, def.name);
      monsters.push(monster);
    } else {
      // Fallback: create a basic monster if not found in SRD, but log the miss
      console.warn(`Monster "${def.monsterId}" not found in SRD data, using goblin stats`);
      const fallback = cloneMonster(SRD_MONSTERS.goblin, def.name || def.monsterId);
      monsters.push(fallback);
    }
  }
  
  return monsters;
}

interface InitiativeRoll {
  id: string;
  name: string;
  type: CombatantType;
  initiative: number;
  dexMod: number;
}

async function rollAllInitiatives(
  party: CharacterSheet[],
  enemies: Monster[]
): Promise<InitiativeRoll[]> {
  const results: InitiativeRoll[] = [];
  
  // Roll for party members
  for (const char of party) {
    const dexMod = calculateModifier(getAbilityScore(char.abilities.dexterity));
    const roll = executeDiceRoll({
      count: 1,
      die: 'd20',
      modifier: 0,
      advantage: false,
      disadvantage: false,
    });
    
    results.push({
      id: char.id ?? uuid(),
      name: char.name,
      type: 'pc',
      initiative: roll.total + dexMod,
      dexMod,
    });
  }
  
  // Roll for enemies
  for (const monster of enemies) {
    const dexMod = calculateModifier(monster.abilities.dex);
    const roll = executeDiceRoll({
      count: 1,
      die: 'd20',
      modifier: 0,
      advantage: false,
      disadvantage: false,
    });
    
    results.push({
      id: monster.id,
      name: monster.name,
      type: 'monster',
      initiative: roll.total + dexMod,
      dexMod,
    });
  }
  
  return results;
}

function createCombatants(
  party: CharacterSheet[],
  enemies: Monster[],
  initiatives: InitiativeRoll[]
): Map<string, Combatant> {
  const combatants = new Map<string, Combatant>();
  
  // Build initiative lookup
  const initiativeMap = new Map<string, number>();
  for (const init of initiatives) {
    initiativeMap.set(init.id, init.initiative);
  }
  
  for (const char of party) {
    const charId = char.id ?? uuid();
    const hp = getHP(char);
    combatants.set(charId, {
      id: uuid(),
      entityId: charId,
      entityType: 'pc',
      name: char.name,
      currentHP: hp.current,
      maxHP: hp.max,
      temporaryHP: hp.temporary ?? 0,
      armorClass: getAC(char),
      position: { x: 0, y: 0 },
      initiative: initiativeMap.get(charId) ?? 0,
      hasActed: false,
      availableResources: createFreshTurnResources(char.speed ?? 30),
    });
  }
  
  for (const monster of enemies) {
    combatants.set(monster.id, {
      id: uuid(),
      entityId: monster.id,
      entityType: 'monster',
      name: monster.name,
      currentHP: monster.hp.current,
      maxHP: monster.hp.max,
      temporaryHP: monster.hp.temp,
      armorClass: monster.ac,
      position: { x: 0, y: 0 },
      initiative: initiativeMap.get(monster.id) ?? 0,
      hasActed: false,
      availableResources: createFreshTurnResources(monster.speed.walk),
    });
  }
  
  return combatants;
}

async function generateCombatStartNarrative(
  _runtime: IAgentRuntime,
  _state: State | undefined,
  enemies: Monster[],
  initiatives: InitiativeRoll[],
  environment?: string,
  surprise?: StartCombatParams['surpriseRound']
): Promise<string> {
  const _enemyNames = enemies.map(e => e.name).join(', ');
  
  let narrative = `⚔️ **COMBAT BEGINS!** ⚔️\n\n`;
  
  if (environment) {
    narrative += `${environment}\n\n`;
  }
  
  if (surprise && surprise.surprisedSide !== 'none') {
    if (surprise.surprisedSide === 'party') {
      narrative += `*The party is surprised!*\n\n`;
    } else {
      narrative += `*You catch the enemies by surprise!*\n\n`;
    }
  }
  
  narrative += `**Initiative Order:**\n`;
  for (let i = 0; i < initiatives.length; i++) {
    const init = initiatives[i];
    const marker = init.type === 'monster' ? '👹' : '⚔️';
    narrative += `${i + 1}. ${marker} ${init.name} - ${init.initiative}\n`;
  }
  
  narrative += `\n*Round 1 begins. ${initiatives[0]?.name}'s turn.*`;
  
  return narrative;
}

export default startCombatAction;
