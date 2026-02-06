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
import type { Monster, CharacterSheet, CombatState, Combatant } from '../../../types';
import { executeDiceRoll, calculateModifier } from '../../../types';
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
        user: '{{user1}}',
        content: {
          text: 'Three goblins burst from the underbrush!',
          action: 'START_COMBAT',
        },
      },
      {
        user: '{{agentName}}',
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
    const combatState = await runtime.getSetting('combatState');
    return !combatState || (combatState as { phase: string }).phase === 'none';
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    const params = options as StartCombatParams;
    
    // Get party members
    const partyMembers = await getPartyMembers(runtime);
    
    // Get enemy monsters
    const enemies = await getEnemyMonsters(runtime, params.enemies);
    
    // Roll initiative for everyone
    const initiatives = await rollAllInitiatives(partyMembers, enemies);
    
    // Sort by initiative (highest first)
    const sortedInitiatives = initiatives.sort((a, b) => {
      if (b.initiative !== a.initiative) return b.initiative - a.initiative;
      // Tie-breaker: higher DEX goes first
      return b.dexMod - a.dexMod;
    });
    
    // Create combat state
    const combatState: CombatState = {
      id: uuid(),
      phase: 'active',
      round: 1,
      turnIndex: 0,
      initiativeOrder: sortedInitiatives.map((i, index) => ({
        id: i.id,
        name: i.name,
        type: i.type,
        initiative: i.initiative,
        isCurrentTurn: index === 0,
        hasActed: false,
        conditions: [],
      })),
      combatants: createCombatants(partyMembers, enemies),
      startedAt: new Date(),
    };
    
    // Apply surprise if applicable
    if (params.surpriseRound && params.surpriseRound.surprisedSide !== 'none') {
      // Surprised creatures skip their first turn
      for (const entry of combatState.initiativeOrder) {
        const isSurprised = 
          (params.surpriseRound.surprisedSide === 'party' && entry.type === 'character') ||
          (params.surpriseRound.surprisedSide === 'enemies' && entry.type === 'monster');
        
        if (isSurprised) {
          entry.hasActed = true; // They "acted" by being surprised
        }
      }
    }
    
    // Save combat state
    await runtime.setSetting('combatState', combatState);
    
    // Generate combat start narrative
    const narrative = await generateCombatStartNarrative(
      runtime,
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
    await runtime.emit('combat_started', {
      combatId: combatState.id,
      enemies: enemies.map(e => ({ id: e.id, name: e.name })),
      initiativeOrder: sortedInitiatives,
      timestamp: new Date(),
    });
    
    return true;
  },
};

async function getPartyMembers(runtime: IAgentRuntime): Promise<CharacterSheet[]> {
  const campaignState = await runtime.getSetting('campaignState');
  if (campaignState && typeof campaignState === 'object') {
    const state = campaignState as { partyMembers?: CharacterSheet[] };
    return state.partyMembers || [];
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
  type: 'character' | 'monster';
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
    const dexMod = calculateModifier(char.abilities.dexterity);
    const roll = executeDiceRoll({
      dice: [{ type: 'd20', count: 1, modifier: 0 }],
      description: `${char.name} initiative`,
    });
    
    results.push({
      id: char.id,
      name: char.name,
      type: 'character',
      initiative: roll.total + dexMod,
      dexMod,
    });
  }
  
  // Roll for enemies
  for (const monster of enemies) {
    const dexMod = calculateModifier(monster.abilities.dex);
    const roll = executeDiceRoll({
      dice: [{ type: 'd20', count: 1, modifier: 0 }],
      description: `${monster.name} initiative`,
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
  enemies: Monster[]
): Map<string, Combatant> {
  const combatants = new Map<string, Combatant>();
  
  for (const char of party) {
    combatants.set(char.id, {
      id: char.id,
      name: char.name,
      type: 'character',
      hp: { current: char.hitPoints.current, max: char.hitPoints.max, temp: char.hitPoints.temporary },
      ac: char.armorClass,
      position: { x: 0, y: 0 },
      conditions: [],
      isAlive: true,
    });
  }
  
  for (const monster of enemies) {
    combatants.set(monster.id, {
      id: monster.id,
      name: monster.name,
      type: 'monster',
      hp: { current: monster.hp.current, max: monster.hp.max, temp: 0 },
      ac: monster.ac,
      position: { x: 0, y: 0 },
      conditions: [],
      isAlive: true,
    });
  }
  
  return combatants;
}

async function generateCombatStartNarrative(
  runtime: IAgentRuntime,
  state: State,
  enemies: Monster[],
  initiatives: InitiativeRoll[],
  environment?: string,
  surprise?: StartCombatParams['surpriseRound']
): Promise<string> {
  const enemyNames = enemies.map(e => e.name).join(', ');
  
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
