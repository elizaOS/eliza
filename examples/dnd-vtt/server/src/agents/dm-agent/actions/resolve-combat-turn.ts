/**
 * Resolve Combat Turn Action
 * Processes a combatant's turn in combat
 */

import type { 
  Action, 
  IAgentRuntime, 
  Memory, 
  State, 
  HandlerCallback 
} from '@elizaos/core';
import type { CombatState, CombatAction, Combatant } from '../../../types';
import { executeDiceRoll } from '../../../types';

export interface ResolveCombatTurnParams {
  combatantId: string;
  actions: CombatAction[];
  movement?: { x: number; y: number };
  endTurn?: boolean;
}

export const resolveCombatTurnAction: Action = {
  name: 'RESOLVE_COMBAT_TURN',
  description: 'Process a combatant\'s actions during their combat turn',
  
  similes: [
    'take combat action',
    'attack',
    'end turn',
    'monster attacks',
    'cast spell in combat',
  ],
  
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'The goblin attacks Thoric with its scimitar.',
          action: 'RESOLVE_COMBAT_TURN',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Goblin 1 lunges at Thoric with a snarl, rusty scimitar slashing through the air!\n\n**Attack Roll:** 🎲 14 + 4 = 18 vs AC 18 - **HIT!**\n\nThe blade catches Thoric across the arm, drawing blood.\n\n**Damage:** 🎲 5 slashing damage\n\nThoric: 38/43 HP\n\n*Goblin 1 ends its turn. Thoric, you\'re up!*',
        },
      },
    ],
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const role = runtime.getSetting('role');
    if (role !== 'dm') return false;
    
    const combatState = runtime.getSetting('combatState') as unknown as CombatState | null;
    return combatState !== null && combatState.isActive;
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ) => {
    const params = (options ?? {}) as unknown as ResolveCombatTurnParams;
    const combatState = runtime.getSetting('combatState') as unknown as CombatState;
    
    const combatant = combatState.combatants.get(params.combatantId);
    if (!combatant) {
      if (callback) {
        await callback({
          text: 'Combatant not found.',
          type: 'error',
        });
      }
      return { success: false };
    }
    
    // Process each action
    const results: string[] = [];
    
    for (const action of params.actions) {
      const result = await processAction(runtime, combatState, params.combatantId, action);
      results.push(result);
    }
    
    // Handle movement if specified
    if (params.movement) {
      combatant.position = params.movement;
    }
    
    // Check for defeated combatants
    const defeatedNames = checkForDefeated(combatState);
    if (defeatedNames.length > 0) {
      results.push(`\n💀 **Defeated:** ${defeatedNames.join(', ')}`);
    }
    
    // Check if combat is over
    const combatOver = checkCombatEnd(combatState);
    
    if (combatOver) {
      combatState.isActive = false;
      results.push('\n\n⚔️ **COMBAT ENDS!** ⚔️');
      
      if (combatOver.winner === 'party') {
        results.push('\n*Victory! The enemies have been defeated.*');
      } else if (combatOver.winner === 'enemies') {
        results.push('\n*Defeat... The party has fallen.*');
      }
    } else if (params.endTurn) {
      // Advance to next turn
      advanceTurn(combatState);
      const nextCombatant = getCurrentCombatant(combatState);
      results.push(`\n\n*${nextCombatant?.name}'s turn.*`);
    }
    
    // Save updated combat state
    runtime.setSetting('combatState', combatState as unknown as string);
    
    if (callback) {
      await callback({
        text: results.join('\n'),
        type: 'combat_resolution',
        metadata: {
          combatId: combatState.id,
          round: combatState.round,
          combatantId: params.combatantId,
          actions: params.actions.map(a => a.description ?? a.type),
          combatOver: combatOver !== null,
        },
      });
    }
    
    // Emit events
    for (const action of params.actions) {
      const combatActionPayload = {
        runtime,
        combatId: combatState.id,
        round: combatState.round,
        actorId: params.combatantId,
        action,
        timestamp: new Date(),
      };
      await runtime.emitEvent('combat_action', combatActionPayload);
    }
    
    if (combatOver) {
      const combatEndedPayload = {
        runtime,
        combatId: combatState.id,
        rounds: combatState.round,
        winner: combatOver.winner,
        timestamp: new Date(),
      };
      await runtime.emitEvent('combat_ended', combatEndedPayload);
    }
    
    return { success: true };
  },
};

async function processAction(
  _runtime: IAgentRuntime,
  combatState: CombatState,
  actorId: string,
  action: CombatAction
): Promise<string> {
  const actor = combatState.combatants.get(actorId);
  if (!actor) return 'Actor not found.';
  
  switch (action.type) {
    case 'attack':
      return processAttack(combatState, actor, action);
    case 'cast_spell':
      return processCastSpell(combatState, actor, action);
    case 'dash':
      return `${actor.name} takes the Dash action, doubling their movement speed.`;
    case 'disengage':
      return `${actor.name} takes the Disengage action. Moving won't provoke opportunity attacks.`;
    case 'dodge':
      return `${actor.name} takes the Dodge action. Attacks against them have disadvantage.`;
    case 'help':
      return `${actor.name} takes the Help action, granting advantage on the next attack against the target.`;
    case 'hide':
      return `${actor.name} attempts to Hide.`;
    case 'ready':
      return `${actor.name} readies an action: "${action.description || 'unspecified'}"`;
    case 'use_object':
      return `${actor.name} uses an object: ${action.description || 'unspecified'}`;
    default:
      return `${actor.name} takes an action.`;
  }
}

function processAttack(
  combatState: CombatState,
  attacker: Combatant,
  action: CombatAction
): string {
  const targetId = action.targetIds?.[0];
  if (!targetId) return `${attacker.name} attacks but has no target!`;
  
  const target = combatState.combatants.get(targetId);
  if (!target) return `Target not found.`;
  
  // Use the attacker's first monster action with an attack bonus, or default to +4
  const weapon = attacker.monster?.actions?.[0];
  const attackBonus = weapon?.attackBonus ?? 4;
  const damageType = weapon?.damageType ?? 'bludgeoning';
  
  // Roll d20 for attack using the dice system
  const attackDiceResult = executeDiceRoll({
    count: 1,
    die: 'd20',
    modifier: 0,
    advantage: false,
    disadvantage: false,
  });
  const attackRoll = attackDiceResult.individualRolls[0] ?? attackDiceResult.total;
  const totalAttack = attackRoll + attackBonus;
  
  const hit = attackRoll === 20 || (attackRoll !== 1 && totalAttack >= target.armorClass);
  const critical = attackRoll === 20;
  
  let result = `${attacker.name} attacks ${target.name} with ${weapon?.name ?? 'a weapon'}!\n\n`;
  result += `**Attack Roll:** 🎲 ${attackRoll} + ${attackBonus} = ${totalAttack} vs AC ${target.armorClass}`;
  
  if (attackRoll === 1) {
    result += ` - **CRITICAL MISS!**`;
  } else if (critical) {
    result += ` - **CRITICAL HIT!**`;
    // Critical hit: roll damage dice twice
    const normalDmg = executeDiceRoll({ count: 1, die: 'd6', modifier: 2, advantage: false, disadvantage: false });
    const critDmg = executeDiceRoll({ count: 1, die: 'd6', modifier: 0, advantage: false, disadvantage: false });
    const damage = normalDmg.total + critDmg.total;
    target.currentHP = Math.max(0, target.currentHP - damage);
    result += `\n\n**Damage:** 🎲 ${damage} ${damageType} (critical!)`;
    result += `\n\n${target.name}: ${target.currentHP}/${target.maxHP} HP`;
  } else if (hit) {
    result += ` - **HIT!**`;
    // Roll actual weapon damage
    const dmgRoll = executeDiceRoll({
      count: 1,
      die: 'd6',
      modifier: 2,
      advantage: false,
      disadvantage: false,
    });
    const damage = dmgRoll.total;
    target.currentHP = Math.max(0, target.currentHP - damage);
    result += `\n\n**Damage:** 🎲 ${damage} ${damageType}`;
    result += `\n\n${target.name}: ${target.currentHP}/${target.maxHP} HP`;
  } else {
    result += ` - **MISS!**`;
  }
  
  if (target.currentHP <= 0) {
    result += `\n\n💀 ${target.name} falls!`;
  }
  
  return result;
}

function processCastSpell(
  combatState: CombatState,
  caster: Combatant,
  action: CombatAction
): string {
  const spellName = action.description || 'a spell';
  let result = `${caster.name} casts ${spellName}`;
  
  const targetId = action.targetIds?.[0];
  if (targetId) {
    const target = combatState.combatants.get(targetId);
    if (target) {
      result += ` targeting ${target.name}`;
    }
  }
  
  result += `!`;
  
  // Roll spell damage if targeting a combatant
  if (targetId) {
    const target = combatState.combatants.get(targetId);
    if (target) {
      const dmgRoll = executeDiceRoll({
        count: 1,
        die: 'd8',
        modifier: 0,
        advantage: false,
        disadvantage: false,
      });
      const damage = dmgRoll.total;
      
      target.currentHP = Math.max(0, target.currentHP - damage);
      result += `\n\n**Damage:** 🎲 ${damage} force`;
      result += `\n\n${target.name}: ${target.currentHP}/${target.maxHP} HP`;
      
      if (target.currentHP <= 0) {
        result += `\n\n💀 ${target.name} falls!`;
      }
    }
  }
  
  return result;
}

function checkForDefeated(combatState: CombatState): string[] {
  const defeated: string[] = [];
  for (const [_id, combatant] of combatState.combatants) {
    if (combatant.currentHP <= 0) {
      defeated.push(combatant.name);
    }
  }
  return defeated;
}

function checkCombatEnd(combatState: CombatState): { winner: 'party' | 'enemies' } | null {
  let partyAlive = false;
  let enemiesAlive = false;
  
  for (const [_id, combatant] of combatState.combatants) {
    if (combatant.currentHP > 0) {
      if (combatant.entityType === 'pc') {
        partyAlive = true;
      } else {
        enemiesAlive = true;
      }
    }
  }
  
  if (!enemiesAlive) return { winner: 'party' };
  if (!partyAlive) return { winner: 'enemies' };
  return null;
}

function advanceTurn(combatState: CombatState): void {
  // Mark current combatant as having acted
  const currentInit = combatState.initiativeOrder[combatState.currentTurnIndex];
  if (currentInit) {
    currentInit.hasActed = true;
  }
  
  // Find next active combatant
  let nextIndex = combatState.currentTurnIndex + 1;
  let looped = false;
  
  while (true) {
    if (nextIndex >= combatState.initiativeOrder.length) {
      // New round
      nextIndex = 0;
      combatState.round++;
      looped = true;
      
      // Reset hasActed for all
      for (const init of combatState.initiativeOrder) {
        init.hasActed = false;
      }
    }
    
    const nextInit = combatState.initiativeOrder[nextIndex];
    if (!nextInit) break;
    const combatant = combatState.combatants.get(nextInit.id);
    
    // Skip dead combatants
    if (combatant && combatant.currentHP > 0) {
      break;
    }
    
    nextIndex++;
    
    // Safety: prevent infinite loop
    if (looped && nextIndex >= combatState.initiativeOrder.length) {
      break;
    }
  }
  
  combatState.currentTurnIndex = nextIndex;
}

function getCurrentCombatant(combatState: CombatState): Combatant | null {
  const currentInit = combatState.initiativeOrder[combatState.currentTurnIndex];
  if (currentInit) {
    return combatState.combatants.get(currentInit.id) ?? null;
  }
  return null;
}

export default resolveCombatTurnAction;
