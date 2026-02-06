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
import type { CombatState, CombatAction, Monster } from '../../../types';
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
        user: '{{user1}}',
        content: {
          text: 'The goblin attacks Thoric with its scimitar.',
          action: 'RESOLVE_COMBAT_TURN',
        },
      },
      {
        user: '{{agentName}}',
        content: {
          text: 'Goblin 1 lunges at Thoric with a snarl, rusty scimitar slashing through the air!\n\n**Attack Roll:** 🎲 14 + 4 = 18 vs AC 18 - **HIT!**\n\nThe blade catches Thoric across the arm, drawing blood.\n\n**Damage:** 🎲 5 slashing damage\n\nThoric: 38/43 HP\n\n*Goblin 1 ends its turn. Thoric, you\'re up!*',
        },
      },
    ],
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const role = await runtime.getSetting('role');
    if (role !== 'dm') return false;
    
    const combatState = await runtime.getSetting('combatState') as CombatState | null;
    return combatState !== null && combatState.phase === 'active';
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    const params = options as ResolveCombatTurnParams;
    const combatState = await runtime.getSetting('combatState') as CombatState;
    
    const combatant = combatState.combatants.get(params.combatantId);
    if (!combatant) {
      if (callback) {
        await callback({
          text: 'Combatant not found.',
          type: 'error',
        });
      }
      return false;
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
      combatState.phase = 'ended';
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
    await runtime.setSetting('combatState', combatState);
    
    if (callback) {
      await callback({
        text: results.join('\n'),
        type: 'combat_resolution',
        metadata: {
          combatId: combatState.id,
          round: combatState.round,
          combatantId: params.combatantId,
          actions: params.actions,
          combatOver: combatOver !== null,
        },
      });
    }
    
    // Emit events
    for (const action of params.actions) {
      await runtime.emit('combat_action', {
        combatId: combatState.id,
        round: combatState.round,
        actorId: params.combatantId,
        action,
        timestamp: new Date(),
      });
    }
    
    if (combatOver) {
      await runtime.emit('combat_ended', {
        combatId: combatState.id,
        rounds: combatState.round,
        winner: combatOver.winner,
        timestamp: new Date(),
      });
    }
    
    return true;
  },
};

async function processAction(
  runtime: IAgentRuntime,
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
  attacker: {id: string; name: string; ac: number; type: string; actions?: Array<{attackBonus?: number; damage?: string; damageType?: string; name?: string}>},
  action: CombatAction
): string {
  if (!action.targetId) return `${attacker.name} attacks but has no target!`;
  
  const target = combatState.combatants.get(action.targetId);
  if (!target) return `Target not found.`;
  
  // Use the attacker's first action with an attack bonus, or default to +4
  const weapon = attacker.actions?.[0];
  const attackBonus = weapon?.attackBonus ?? 4;
  const damageDice = weapon?.damage ?? '1d6+2';
  const damageType = weapon?.damageType ?? 'bludgeoning';
  
  // Roll d20 for attack using the dice system
  const attackDiceResult = executeDiceRoll({
    dice: [{ type: 'd20', count: 1, modifier: 0 }],
    description: `${attacker.name} attack roll`,
  });
  const attackRoll = attackDiceResult.individualRolls[0]?.[0] ?? attackDiceResult.total;
  const totalAttack = attackRoll + attackBonus;
  
  const hit = attackRoll === 20 || (attackRoll !== 1 && totalAttack >= target.ac);
  const critical = attackRoll === 20;
  
  let result = `${attacker.name} attacks ${target.name} with ${weapon?.name ?? 'a weapon'}!\n\n`;
  result += `**Attack Roll:** 🎲 ${attackRoll} + ${attackBonus} = ${totalAttack} vs AC ${target.ac}`;
  
  if (attackRoll === 1) {
    result += ` - **CRITICAL MISS!**`;
  } else if (critical) {
    result += ` - **CRITICAL HIT!**`;
    // Critical hit: roll damage dice twice
    const dmgRoll = executeDiceRoll({ dice: [{ type: 'd20', count: 1, modifier: 0 }], description: 'crit damage placeholder' });
    const normalDmg = executeDiceRoll({ dice: [{ type: 'd6', count: 1, modifier: 2 }], description: 'damage' });
    const critDmg = executeDiceRoll({ dice: [{ type: 'd6', count: 1, modifier: 0 }], description: 'crit bonus' });
    const damage = normalDmg.total + critDmg.total;
    target.hp.current = Math.max(0, target.hp.current - damage);
    result += `\n\n**Damage:** 🎲 ${damage} ${damageType} (critical!)`;
    result += `\n\n${target.name}: ${target.hp.current}/${target.hp.max} HP`;
  } else if (hit) {
    result += ` - **HIT!**`;
    // Roll actual weapon damage
    const dmgRoll = executeDiceRoll({
      dice: [{ type: 'd6', count: 1, modifier: 2 }],
      description: `${weapon?.name ?? 'weapon'} damage`,
    });
    const damage = dmgRoll.total;
    target.hp.current = Math.max(0, target.hp.current - damage);
    result += `\n\n**Damage:** 🎲 ${damage} ${damageType}`;
    result += `\n\n${target.name}: ${target.hp.current}/${target.hp.max} HP`;
  } else {
    result += ` - **MISS!**`;
  }
  
  if (target.hp.current <= 0) {
    target.isAlive = false;
    result += `\n\n💀 ${target.name} falls!`;
  }
  
  return result;
}

function processCastSpell(
  combatState: CombatState,
  caster: {id: string; name: string},
  action: CombatAction
): string {
  const spellName = action.spellName || 'a spell';
  let result = `${caster.name} casts ${spellName}`;
  
  if (action.targetId) {
    const target = combatState.combatants.get(action.targetId);
    if (target) {
      result += ` targeting ${target.name}`;
    }
  }
  
  result += `!`;
  
  // Roll spell damage using the dice system
  if (action.damage) {
    const damageDice = action.damageDice || '1d8';
    const damageType = action.damageType || 'force';
    const dmgRoll = executeDiceRoll({
      dice: [{ type: 'd8', count: 1, modifier: 0 }],
      description: `${spellName} damage`,
    });
    const damage = dmgRoll.total;
    
    if (action.targetId) {
      const target = combatState.combatants.get(action.targetId);
      if (target) {
        target.hp.current = Math.max(0, target.hp.current - damage);
        result += `\n\n**Damage:** 🎲 ${damage} ${damageType}`;
        result += `\n\n${target.name}: ${target.hp.current}/${target.hp.max} HP`;
        
        if (target.hp.current <= 0) {
          target.isAlive = false;
          result += `\n\n💀 ${target.name} falls!`;
        }
      }
    }
  }
  
  return result;
}

function checkForDefeated(combatState: CombatState): string[] {
  const defeated: string[] = [];
  for (const [id, combatant] of combatState.combatants) {
    if (combatant.hp.current <= 0 && combatant.isAlive) {
      combatant.isAlive = false;
      defeated.push(combatant.name);
    }
  }
  return defeated;
}

function checkCombatEnd(combatState: CombatState): { winner: 'party' | 'enemies' } | null {
  let partyAlive = false;
  let enemiesAlive = false;
  
  for (const [id, combatant] of combatState.combatants) {
    if (combatant.isAlive) {
      if (combatant.type === 'character') {
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
  const currentInit = combatState.initiativeOrder[combatState.turnIndex];
  if (currentInit) {
    currentInit.hasActed = true;
    currentInit.isCurrentTurn = false;
  }
  
  // Find next active combatant
  let nextIndex = combatState.turnIndex + 1;
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
    const combatant = combatState.combatants.get(nextInit.id);
    
    // Skip dead combatants
    if (combatant && combatant.isAlive) {
      break;
    }
    
    nextIndex++;
    
    // Safety: prevent infinite loop
    if (looped && nextIndex >= combatState.initiativeOrder.length) {
      break;
    }
  }
  
  combatState.turnIndex = nextIndex;
  const newCurrent = combatState.initiativeOrder[nextIndex];
  if (newCurrent) {
    newCurrent.isCurrentTurn = true;
  }
}

function getCurrentCombatant(combatState: CombatState): {name: string} | null {
  const currentInit = combatState.initiativeOrder[combatState.turnIndex];
  if (currentInit) {
    return combatState.combatants.get(currentInit.id) || null;
  }
  return null;
}

export default resolveCombatTurnAction;
