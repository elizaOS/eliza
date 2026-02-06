/**
 * Initiative Tracker
 * Manages initiative order and turn progression
 */

import type { Combatant, CombatEncounter } from './combat-state';
import type { ActiveCondition } from '../types';
import { resetTurnResources, isIncapacitated, isDead } from './combat-state';
import { rollD20, rollDice } from '../dice';

export interface InitiativeRoll {
  combatantId: string;
  combatantName: string;
  roll: number;
  modifier: number;
  total: number;
  advantage?: boolean;
}

/**
 * Roll initiative for a single combatant
 */
export function rollInitiative(
  combatant: Combatant,
  advantage: boolean = false
): InitiativeRoll {
  let roll: number;
  
  if (advantage) {
    const roll1 = rollD20();
    const roll2 = rollD20();
    roll = Math.max(roll1, roll2);
  } else {
    roll = rollD20();
  }
  
  return {
    combatantId: combatant.id,
    combatantName: combatant.name,
    roll,
    modifier: combatant.dexterityModifier,
    total: roll + combatant.dexterityModifier,
    advantage,
  };
}

/**
 * Roll initiative for multiple combatants and sort them
 */
export function rollGroupInitiative(
  combatants: Combatant[],
  advantageIds: string[] = []
): InitiativeRoll[] {
  const rolls = combatants.map(c => 
    rollInitiative(c, advantageIds.includes(c.id))
  );
  
  // Sort by total (descending), then by dex modifier (descending) for ties
  return rolls.sort((a, b) => {
    if (b.total !== a.total) {
      return b.total - a.total;
    }
    return b.modifier - a.modifier;
  });
}

/**
 * Set initiative order based on rolls
 */
export function setInitiativeOrder(
  combatants: Combatant[],
  rolls: InitiativeRoll[]
): Combatant[] {
  // Create a map of combatant ID to initiative total
  const initiativeMap = new Map(
    rolls.map(r => [r.combatantId, r.total])
  );
  
  // Update combatants with their initiative values and sort
  const withInitiative = combatants.map(c => ({
    ...c,
    initiative: initiativeMap.get(c.id) || 0,
  }));
  
  return withInitiative.sort((a, b) => {
    if (b.initiative !== a.initiative) {
      return b.initiative - a.initiative;
    }
    return b.dexterityModifier - a.dexterityModifier;
  });
}

/**
 * Add a combatant to existing initiative order
 */
export function addToInitiative(
  order: Combatant[],
  newCombatant: Combatant,
  initiativeRoll: number
): Combatant[] {
  const withInitiative = {
    ...newCombatant,
    initiative: initiativeRoll,
  };
  
  // Find the right position
  const insertIndex = order.findIndex(c => 
    c.initiative < initiativeRoll || 
    (c.initiative === initiativeRoll && c.dexterityModifier < withInitiative.dexterityModifier)
  );
  
  if (insertIndex === -1) {
    return [...order, withInitiative];
  }
  
  const newOrder = [...order];
  newOrder.splice(insertIndex, 0, withInitiative);
  return newOrder;
}

/**
 * Remove a combatant from initiative order
 */
export function removeFromInitiative(
  order: Combatant[],
  combatantId: string
): { newOrder: Combatant[]; removed: Combatant | undefined } {
  const index = order.findIndex(c => c.id === combatantId);
  
  if (index === -1) {
    return { newOrder: order, removed: undefined };
  }
  
  const newOrder = [...order];
  const [removed] = newOrder.splice(index, 1);
  return { newOrder, removed };
}

/**
 * Get the current combatant whose turn it is
 */
export function getCurrentCombatant(encounter: CombatEncounter): Combatant | null {
  if (encounter.initiativeOrder.length === 0) {
    return null;
  }
  
  if (encounter.currentTurnIndex >= encounter.initiativeOrder.length) {
    return null;
  }
  
  return encounter.initiativeOrder[encounter.currentTurnIndex];
}

/**
 * Advance to the next turn
 */
export function advanceTurn(encounter: CombatEncounter): CombatEncounter {
  const newEncounter = { ...encounter };
  
  // Find next valid combatant (skip dead/incapacitated)
  let nextIndex = (encounter.currentTurnIndex + 1) % encounter.initiativeOrder.length;
  let checkedCount = 0;
  
  while (checkedCount < encounter.initiativeOrder.length) {
    const nextCombatant = encounter.initiativeOrder[nextIndex];
    
    // Skip if dead or stable (not their turn)
    if (!isDead(nextCombatant)) {
      break;
    }
    
    nextIndex = (nextIndex + 1) % encounter.initiativeOrder.length;
    checkedCount++;
  }
  
  // Check if we wrapped around (new round)
  if (nextIndex <= encounter.currentTurnIndex || checkedCount >= encounter.initiativeOrder.length) {
    newEncounter.round++;
    
    // Reset round-based effects
    newEncounter.lairActionUsedThisRound = false;
    
    // Process start-of-round effects
    newEncounter.initiativeOrder = processRoundStart(newEncounter.initiativeOrder);
  }
  
  newEncounter.currentTurnIndex = nextIndex;
  
  // Reset turn resources for the new current combatant
  if (newEncounter.initiativeOrder[nextIndex]) {
    newEncounter.initiativeOrder = newEncounter.initiativeOrder.map((c, i) =>
      i === nextIndex ? resetTurnResources(c) : c
    );
  }
  
  return newEncounter;
}

/**
 * Process effects at the start of a new round
 */
function processRoundStart(combatants: Combatant[]): Combatant[] {
  return combatants.map(combatant => {
    const updatedConditions = (combatant.conditions
      .map(condition => {
        // Decrement duration
        if (typeof condition.duration === 'object' && 'type' in condition.duration) {
          const dur = condition.duration as Record<string, unknown>;
          if (dur.type === 'rounds' && typeof dur.remaining === 'number') {
            return {
              ...condition,
              duration: {
                ...(condition.duration as Record<string, unknown>),
                remaining: dur.remaining - 1,
              },
            };
          }
        }
        return condition;
      }) as ActiveCondition[])
      // Remove expired conditions
      .filter(condition => {
        if (typeof condition.duration === 'object' && 'type' in condition.duration) {
          const dur = condition.duration as Record<string, unknown>;
          if (dur.type === 'rounds') {
            return typeof dur.remaining === 'number' && dur.remaining > 0;
          }
        }
        return true;
      });
    
    return {
      ...combatant,
      conditions: updatedConditions,
    };
  });
}

/**
 * Delay a combatant's turn (move later in initiative)
 */
export function delayTurn(
  encounter: CombatEncounter,
  combatantId: string,
  newInitiative: number
): CombatEncounter {
  const combatantIndex = encounter.initiativeOrder.findIndex(c => c.id === combatantId);
  
  if (combatantIndex === -1) {
    return encounter;
  }
  
  const combatant = encounter.initiativeOrder[combatantIndex];
  const { newOrder: withoutCombatant } = removeFromInitiative(
    encounter.initiativeOrder,
    combatantId
  );
  
  const newOrder = addToInitiative(withoutCombatant, combatant, newInitiative);
  
  // Adjust current turn index if needed
  let newTurnIndex = encounter.currentTurnIndex;
  if (combatantIndex < encounter.currentTurnIndex) {
    newTurnIndex--;
  }
  
  return {
    ...encounter,
    initiativeOrder: newOrder,
    currentTurnIndex: newTurnIndex,
  };
}

/**
 * Ready an action (hold until a trigger)
 */
export interface ReadiedAction {
  combatantId: string;
  combatantName: string;
  trigger: string;
  action: string;
  expiresAtRound: number;
}

/**
 * Get initiative order as formatted text
 */
export function formatInitiativeOrder(encounter: CombatEncounter): string {
  let output = `**Round ${encounter.round}**\n\n`;
  output += '| # | Name | Initiative | HP | Status |\n';
  output += '|---|------|------------|----|---------|\n';
  
  encounter.initiativeOrder.forEach((combatant, index) => {
    const isCurrent = index === encounter.currentTurnIndex;
    const marker = isCurrent ? '▶️' : `${index + 1}`;
    
    let status = '';
    if (isDead(combatant)) {
      status = '💀 Dead';
    } else if (combatant.hp.current <= 0) {
      status = `🩸 Dying (${combatant.deathSaves?.successes || 0}✓/${combatant.deathSaves?.failures || 0}✗)`;
    } else if (combatant.conditions.length > 0) {
      status = combatant.conditions.map(c => c.name).join(', ');
    } else {
      status = '✓';
    }
    
    const hpDisplay = combatant.type === 'monster' && combatant.hp.current > 0
      ? getHealthDescription(combatant.hp.current, combatant.hp.max)
      : `${combatant.hp.current}/${combatant.hp.max}`;
    
    output += `| ${marker} | ${combatant.name} | ${combatant.initiative} | ${hpDisplay} | ${status} |\n`;
  });
  
  return output;
}

function getHealthDescription(current: number, max: number): string {
  const percentage = current / max;
  
  if (percentage >= 1) return 'Healthy';
  if (percentage >= 0.75) return 'Lightly Wounded';
  if (percentage >= 0.5) return 'Wounded';
  if (percentage >= 0.25) return 'Badly Wounded';
  if (percentage > 0) return 'Near Death';
  return 'Down';
}
