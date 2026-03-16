/**
 * Combat Manager
 * High-level combat encounter management
 */

import { v4 as uuid } from 'uuid';
import type {
  Combatant,
  CombatEncounter,
  CombatLogEntry,
  EnvironmentalEffect,
} from './combat-state';
import {
  createCombatantFromCharacter,
  createCombatantFromMonster,
  isDead,
  isStable,
} from './combat-state';
import { executeDeathSave } from './combat-actions';
import {
  rollGroupInitiative,
  setInitiativeOrder,
  addToInitiative,
  removeFromInitiative,
  getCurrentCombatant,
  advanceTurn,
  formatInitiativeOrder,
  type InitiativeRoll,
} from './initiative-tracker';
import type { CharacterSheet, Monster } from '../types';
import { worldRepository } from '../persistence';

/**
 * Create a new combat encounter
 */
export function createEncounter(
  campaignId: string,
  sessionId: string,
  options: {
    battleMapId?: string;
    lightingCondition?: 'bright' | 'dim' | 'darkness';
    environmentalEffects?: EnvironmentalEffect[];
  } = {}
): CombatEncounter {
  return {
    id: uuid(),
    campaignId,
    sessionId,
    battleMapId: options.battleMapId,
    status: 'preparing',
    round: 0,
    currentTurnIndex: 0,
    initiativeOrder: [],
    defeatedCombatants: [],
    fledCombatants: [],
    environmentalEffects: options.environmentalEffects || [],
    lightingCondition: options.lightingCondition || 'bright',
    lairActionsAvailable: false,
    lairActionUsedThisRound: false,
    legendaryActionsRemaining: new Map(),
    actionLog: [],
    startedAt: new Date(),
  };
}

/**
 * Add party members to an encounter
 */
export function addPartyToEncounter(
  encounter: CombatEncounter,
  characters: CharacterSheet[]
): { encounter: CombatEncounter; rolls: InitiativeRoll[] } {
  const combatants = characters.map(c =>
    createCombatantFromCharacter(c, 0) // Initiative will be set after rolling
  );
  
  const rolls = rollGroupInitiative(combatants);
  const withInitiative = setInitiativeOrder(combatants, rolls);
  
  return {
    encounter: {
      ...encounter,
      initiativeOrder: [...encounter.initiativeOrder, ...withInitiative],
    },
    rolls,
  };
}

/**
 * Add monsters to an encounter
 */
export function addMonstersToEncounter(
  encounter: CombatEncounter,
  monsters: Monster[],
  groupByType: boolean = true
): { encounter: CombatEncounter; rolls: InitiativeRoll[] } {
  const combatants: Combatant[] = [];
  
  if (groupByType) {
    // Group identical monsters and number them
    const monsterCounts = new Map<string, number>();
    
    for (const monster of monsters) {
      const count = monsterCounts.get(monster.id) || 0;
      combatants.push(createCombatantFromMonster(monster, 0, count));
      monsterCounts.set(monster.id, count + 1);
    }
  } else {
    monsters.forEach((monster, index) => {
      combatants.push(createCombatantFromMonster(monster, 0, index));
    });
  }
  
  const rolls = rollGroupInitiative(combatants);
  const withInitiative = setInitiativeOrder(combatants, rolls);
  
  return {
    encounter: {
      ...encounter,
      initiativeOrder: [...encounter.initiativeOrder, ...withInitiative],
    },
    rolls,
  };
}

/**
 * Start combat (finalize initiative order and begin round 1)
 */
export function startCombat(encounter: CombatEncounter): CombatEncounter {
  // Sort all combatants by initiative
  const sorted = [...encounter.initiativeOrder].sort((a, b) => {
    if (b.initiative !== a.initiative) {
      return b.initiative - a.initiative;
    }
    return b.dexterityModifier - a.dexterityModifier;
  });
  
  // Legendary actions: populated when monster data includes them
  const legendaryActions = new Map<string, number>();
  
  return {
    ...encounter,
    status: 'active',
    round: 1,
    currentTurnIndex: 0,
    initiativeOrder: sorted,
    legendaryActionsRemaining: legendaryActions,
  };
}

/**
 * End the current combatant's turn and advance to next
 */
export function endTurn(encounter: CombatEncounter): CombatEncounter {
  // Clean up turn-based conditions on the current combatant before advancing
  const currentCombatant = getCurrentCombatant(encounter);
  let cleanedEncounter = encounter;
  
  if (currentCombatant) {
    const updatedConditions = tickTurnConditions(currentCombatant.conditions, 'end_of_turn');
    
    if (updatedConditions.length !== currentCombatant.conditions.length) {
      const updatedCombatant = { ...currentCombatant, conditions: updatedConditions };
      cleanedEncounter = updateCombatant(cleanedEncounter, updatedCombatant);
    }
    
    // Add log entry
    const logEntry: CombatLogEntry = {
      timestamp: new Date(),
      round: encounter.round,
      turnOrder: encounter.currentTurnIndex,
      actorId: currentCombatant.id,
      actorName: currentCombatant.name,
      actionType: 'free_action',
      actionDescription: 'End turn',
      outcome: 'Turn ended',
    };
    cleanedEncounter = {
      ...cleanedEncounter,
      actionLog: [...cleanedEncounter.actionLog, logEntry],
    };
  }
  
  // Advance to next combatant
  const advanced = advanceTurn(cleanedEncounter);
  
  // Clean up start-of-turn conditions on the NEW current combatant
  let result = advanced;
  const nextCombatant = getCurrentCombatant(result);
  if (nextCombatant) {
    const cleanedNextConditions = tickTurnConditions(nextCombatant.conditions, 'start_of_turn');
    if (cleanedNextConditions.length !== nextCombatant.conditions.length) {
      const updatedNext = { ...nextCombatant, conditions: cleanedNextConditions };
      result = updateCombatant(result, updatedNext);
    }
    
    // Auto-trigger death saves for dying PCs at start of their turn (5e PHB p.197)
    const currentAfterClean = getCurrentCombatant(result);
    if (currentAfterClean && currentAfterClean.type === 'pc' && 
        currentAfterClean.hp.current <= 0 && currentAfterClean.deathSaves &&
        !isDead(currentAfterClean) && !isStable(currentAfterClean)) {
      const deathSaveResult = executeDeathSave(currentAfterClean);
      for (const updated of deathSaveResult.updatedCombatants) {
        result = updateCombatant(result, updated);
      }
      // Log the auto death save
      const logEntry: CombatLogEntry = {
        timestamp: new Date(),
        round: result.round,
        turnOrder: result.currentTurnIndex,
        actorId: currentAfterClean.id,
        actorName: currentAfterClean.name,
        actionType: 'death_save',
        actionDescription: 'Automatic Death Saving Throw',
        outcome: deathSaveResult.logEntry.outcome,
      };
      result = { ...result, actionLog: [...result.actionLog, logEntry] };
    }
  }
  
  return result;
}

/**
 * Tick and clean up turn-based conditions.
 * Handles all ConditionDuration shapes:
 *   - number (simple counter, decrements each turn)
 *   - { type: 'turns', value, endsAt } (proper ConditionDuration)
 *   - { type: 'rounds', roundsRemaining } (decremented at round start, not here)
 *   - { type: string, description } (special durations, persist)
 *   - permanent / until_save / until_dispelled (persist)
 */
function tickTurnConditions(
  conditions: CombatEncounter['initiativeOrder'][0]['conditions'],
  phase: 'start_of_turn' | 'end_of_turn',
): CombatEncounter['initiativeOrder'][0]['conditions'] {
  return conditions
    .map(condition => {
      const dur = condition.duration;
      if (dur === undefined || dur === null) return condition;
      
      // Simple number duration: decrement each end-of-turn
      if (typeof dur === 'number') {
        if (phase !== 'end_of_turn') return condition;
        const remaining = dur - 1;
        return remaining <= 0 ? null : { ...condition, duration: remaining };
      }
      
      // Object duration
      if (typeof dur === 'object') {
        const durObj = dur as Record<string, unknown>;
        const durType = durObj.type as string | undefined;
        
        // 'turns' type: check if this condition expires at this phase
        if (durType === 'turns') {
          const endsAt = (durObj.endsAt as string) ?? 'end_of_turn';
          if (endsAt !== phase) return condition;
          
          const value = (durObj.value as number) ?? 1;
          const remaining = value - 1;
          return remaining <= 0 ? null : { ...condition, duration: { ...durObj, value: remaining } };
        }
        
        // 'permanent', 'until_save', 'until_dispelled', 'special' — persist
        if (durType === 'permanent' || durType === 'until_save' || durType === 'until_dispelled' || durType === 'special') {
          return condition;
        }
        
        // 'rounds' — handled at round boundary, not turn boundary
        if (durType === 'rounds') {
          return condition;
        }
        
        // 'minutes', 'hours' — time-based, handled elsewhere
        if (durType === 'minutes' || durType === 'hours') {
          return condition;
        }
        
        // Legacy { type: 'turn', remaining } format (compatibility)
        if (durType === 'turn' && typeof durObj.remaining === 'number') {
          if (phase !== 'end_of_turn') return condition;
          const remaining = (durObj.remaining as number) - 1;
          return remaining <= 0 ? null : { ...condition, duration: { ...durObj, remaining } };
        }
      }
      
      return condition;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null) as import('../types').ActiveCondition[];
}

/**
 * Update a combatant in the encounter
 */
export function updateCombatant(
  encounter: CombatEncounter,
  updatedCombatant: Combatant
): CombatEncounter {
  const index = encounter.initiativeOrder.findIndex(c => c.id === updatedCombatant.id);
  
  if (index === -1) {
    return encounter;
  }
  
  const newOrder = [...encounter.initiativeOrder];
  newOrder[index] = updatedCombatant;
  
  // Check if combatant is defeated
  if (isDead(updatedCombatant) || (updatedCombatant.type === 'monster' && updatedCombatant.hp.current <= 0)) {
    const { newOrder: orderWithoutDefeated, removed } = removeFromInitiative(
      newOrder,
      updatedCombatant.id
    );
    
    return {
      ...encounter,
      initiativeOrder: orderWithoutDefeated,
      defeatedCombatants: removed 
        ? [...encounter.defeatedCombatants, removed]
        : encounter.defeatedCombatants,
      currentTurnIndex: index < encounter.currentTurnIndex
        ? encounter.currentTurnIndex - 1
        : encounter.currentTurnIndex,
    };
  }
  
  return {
    ...encounter,
    initiativeOrder: newOrder,
  };
}

/**
 * Update multiple combatants
 */
export function updateCombatants(
  encounter: CombatEncounter,
  updatedCombatants: Combatant[]
): CombatEncounter {
  let current = encounter;
  for (const combatant of updatedCombatants) {
    current = updateCombatant(current, combatant);
  }
  return current;
}

/**
 * Add a log entry to the encounter
 */
export function addLogEntry(
  encounter: CombatEncounter,
  entry: Omit<CombatLogEntry, 'timestamp' | 'round' | 'turnOrder'>
): CombatEncounter {
  const fullEntry: CombatLogEntry = {
    ...entry,
    timestamp: new Date(),
    round: encounter.round,
    turnOrder: encounter.currentTurnIndex,
  };
  
  return {
    ...encounter,
    actionLog: [...encounter.actionLog, fullEntry],
  };
}

/**
 * Check if combat should end
 */
export function shouldCombatEnd(encounter: CombatEncounter): {
  shouldEnd: boolean;
  reason?: 'all_enemies_defeated' | 'all_party_defeated' | 'fled' | 'truce';
  winners?: 'party' | 'enemies' | 'none';
} {
  const partyMembers = encounter.initiativeOrder.filter(c => c.type === 'pc');
  const enemies = encounter.initiativeOrder.filter(c => c.type === 'monster' || c.type === 'npc');
  
  const activeParty = partyMembers.filter(c => !isDead(c) && c.hp.current > 0);
  const activeEnemies = enemies.filter(c => !isDead(c) && c.hp.current > 0);
  
  if (activeEnemies.length === 0 && enemies.length > 0) {
    return {
      shouldEnd: true,
      reason: 'all_enemies_defeated',
      winners: 'party',
    };
  }
  
  if (activeParty.length === 0 && partyMembers.length > 0) {
    return {
      shouldEnd: true,
      reason: 'all_party_defeated',
      winners: 'enemies',
    };
  }
  
  return { shouldEnd: false };
}

/**
 * End combat encounter
 */
export function endCombat(
  encounter: CombatEncounter,
  reason: string
): CombatEncounter {
  return {
    ...encounter,
    status: 'ended',
    endedAt: new Date(),
    actionLog: [
      ...encounter.actionLog,
      {
        timestamp: new Date(),
        round: encounter.round,
        turnOrder: encounter.currentTurnIndex,
        actorId: 'system',
        actorName: 'Combat',
        actionType: 'environmental' as const,
        actionDescription: 'Combat ended',
        outcome: reason,
      },
    ],
  };
}

/**
 * Get combat summary for narrative
 */
export function getCombatSummary(encounter: CombatEncounter): {
  duration: { rounds: number; minutes: number };
  casualties: { party: string[]; enemies: string[] };
  damageDealt: { byParty: number; byEnemies: number };
  mvp?: { name: string; contribution: string };
} {
  const rounds = encounter.round;
  const minutes = rounds; // Each round is ~6 seconds, but we round up to minutes for narrative
  
  const partyCasualties = encounter.defeatedCombatants
    .filter(c => c.type === 'pc')
    .map(c => c.name);
  
  const enemyCasualties = encounter.defeatedCombatants
    .filter(c => c.type !== 'pc')
    .map(c => c.name);
  
  // Calculate damage from log
  let partyDamage = 0;
  let enemyDamage = 0;
  const damageByActor = new Map<string, number>();
  
  for (const entry of encounter.actionLog) {
    if (entry.damage) {
      const actor = encounter.initiativeOrder.find(c => c.id === entry.actorId) ||
                   encounter.defeatedCombatants.find(c => c.id === entry.actorId);
      
      if (actor) {
        if (actor.type === 'pc') {
          partyDamage += entry.damage.amount;
        } else {
          enemyDamage += entry.damage.amount;
        }
        
        damageByActor.set(
          actor.name,
          (damageByActor.get(actor.name) || 0) + entry.damage.amount
        );
      }
    }
  }
  
  // Find MVP (most damage dealt)
  let mvp: { name: string; contribution: string } | undefined;
  let maxDamage = 0;
  
  for (const [name, damage] of damageByActor) {
    const actor = [...encounter.initiativeOrder, ...encounter.defeatedCombatants]
      .find(c => c.name === name);
    
    if (actor?.type === 'pc' && damage > maxDamage) {
      maxDamage = damage;
      mvp = { name, contribution: `${damage} damage dealt` };
    }
  }
  
  return {
    duration: { rounds, minutes },
    casualties: { party: partyCasualties, enemies: enemyCasualties },
    damageDealt: { byParty: partyDamage, byEnemies: enemyDamage },
    mvp,
  };
}

/**
 * Log combat to database
 * Accepts optional gameTime from campaign state instead of using hardcoded values.
 */
export async function logCombatToDatabase(
  encounter: CombatEncounter,
  gameTime?: { year: number; month: number; day: number; hour: number; minute: number }
): Promise<void> {
  const time = gameTime ?? {
    year: 1490, month: 1, day: 1, hour: 12, minute: 0,
  };

  for (const entry of encounter.actionLog) {
    if (entry.actionType === 'attack' || entry.actionType === 'cast_spell') {
      await worldRepository.logCombatAction({
        campaignId: encounter.campaignId,
        encounterId: encounter.id,
        sessionId: encounter.sessionId,
        roundNumber: entry.round,
        turnOrder: entry.turnOrder,
        actorId: entry.actorId,
        actorName: entry.actorName,
        actionType: entry.actionType,
        actionDescription: entry.actionDescription,
        targetIds: entry.targetIds || [],
        diceRolls: (entry.diceRolls || []).map(r => ({ notation: r.dice, result: r.total, purpose: r.type })),
        damage: entry.damage?.amount,
        healing: entry.healing,
        outcome: entry.outcome,
        gameTime: time,
      });
    }
  }
}

/**
 * Format combat status for display
 */
export function formatCombatStatus(encounter: CombatEncounter): string {
  if (encounter.status === 'preparing') {
    return `**Preparing Combat**\n\nRoll initiative to begin!`;
  }
  
  if (encounter.status === 'ended') {
    const summary = getCombatSummary(encounter);
    let text = `**Combat Ended** (${summary.duration.rounds} rounds)\n\n`;
    
    if (summary.casualties.enemies.length > 0) {
      text += `**Enemies Defeated:** ${summary.casualties.enemies.join(', ')}\n`;
    }
    
    if (summary.casualties.party.length > 0) {
      text += `**Party Casualties:** ${summary.casualties.party.join(', ')}\n`;
    }
    
    if (summary.mvp) {
      text += `\n**MVP:** ${summary.mvp.name} (${summary.mvp.contribution})`;
    }
    
    return text;
  }
  
  // Active combat
  let text = formatInitiativeOrder(encounter);
  
  // Add environmental effects
  if (encounter.environmentalEffects.length > 0) {
    text += '\n**Environmental Effects:**\n';
    for (const effect of encounter.environmentalEffects) {
      text += `- ${effect.name}: ${effect.description}\n`;
    }
  }
  
  // Add current turn prompt
  const current = getCurrentCombatant(encounter);
  if (current) {
    text += `\n---\n**Current Turn:** ${current.name}`;
    text += `\n*Available: `;
    
    const available: string[] = [];
    if (!current.turnResources.actionUsed) available.push('Action');
    if (!current.turnResources.bonusActionUsed) available.push('Bonus Action');
    if (!current.turnResources.reactionUsed) available.push('Reaction');
    if (current.turnResources.movementRemaining > 0) {
      available.push(`${current.turnResources.movementRemaining}ft Movement`);
    }
    
    text += available.join(', ') + '*';
  }
  
  return text;
}

export {
  getCurrentCombatant,
  formatInitiativeOrder,
};
