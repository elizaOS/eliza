/**
 * Combat Actions
 * All standard D&D 5e combat actions
 */

import type { 
  Combatant, 
  CombatEncounter, 
  CombatLogEntry,
  CombatActionType,
  DiceRollResult,
} from './combat-state';
import type { AbilityName, SkillName, DamageType, ConditionName } from '../types';
import { getCondName } from './condition-utils';
import { rollD20, rollDice, rollWithAdvantage, rollWithDisadvantage } from '../dice';
import { 
  applyDamage, 
  applyHealing, 
  rollDamage,
  checkConcentration,
  breakConcentration,
  type DamageInstance,
} from './damage-healing';
import { 
  applyCondition, 
  removeCondition, 
  hasCondition,
  getAttackModifiers,
  getDefenseModifiers,
  getSaveModifiers,
} from './conditions';
import { calculateDistance, isAdjacent } from '../rules';

/**
 * Result of executing a combat action
 */
export interface ActionResult {
  success: boolean;
  description: string;
  updatedCombatants: Combatant[];
  logEntry: Omit<CombatLogEntry, 'timestamp' | 'round' | 'turnOrder'>;
  triggeredReactions?: string[]; // Combatant IDs that can react
}

/**
 * Execute an attack action
 */
export async function executeAttack(
  attacker: Combatant,
  target: Combatant,
  attackBonus: number,
  damage: { dice: string; type: DamageType },
  options: {
    advantage?: boolean;
    disadvantage?: boolean;
    isMagical?: boolean;
    reach?: number;
    isRanged?: boolean;
    longRange?: boolean;
  } = {}
): Promise<ActionResult> {
  const attackModifiers = getAttackModifiers(attacker);
  const defenseModifiers = getDefenseModifiers(target);
  
  // Calculate final advantage/disadvantage state
  let hasAdvantage = options.advantage || attackModifiers.hasAdvantage || defenseModifiers.attackerHasAdvantage;
  let hasDisadvantage = options.disadvantage || attackModifiers.hasDisadvantage || defenseModifiers.attackerHasDisadvantage;
  
  // Check custom combat conditions from Help, Hide, Dodge actions
  if (attacker.conditions.some(c => getCondName(c).toLowerCase() === 'helped_attack')) hasAdvantage = true;
  if (attacker.conditions.some(c => getCondName(c).toLowerCase() === 'hidden')) hasAdvantage = true;
  if (target.conditions.some(c => getCondName(c).toLowerCase() === 'dodging')) hasDisadvantage = true;
  
  // Long range gives disadvantage
  if (options.longRange) {
    hasDisadvantage = true;
  }
  
  // Auto-fail conditions
  if (attackModifiers.autoFail) {
    return {
      success: false,
      description: `${attacker.name} cannot attack while ${attacker.conditions[0]?.name || 'incapacitated'}!`,
      updatedCombatants: [attacker, target],
      logEntry: {
        actorId: attacker.id,
        actorName: attacker.name,
        actionType: 'attack',
        actionDescription: 'Attack (auto-fail)',
        targetIds: [target.id],
        targetNames: [target.name],
        outcome: 'Auto-failed due to condition',
      },
    };
  }
  
  // Roll the attack
  let attackRoll: number;
  let diceRolls: DiceRollResult[] = [];
  
  if (hasAdvantage && !hasDisadvantage) {
    const { result, rolls } = rollWithAdvantage();
    attackRoll = result;
    diceRolls.push({
      type: 'attack',
      dice: '1d20',
      rolls,
      modifier: attackBonus,
      total: result + attackBonus,
      advantage: true,
      droppedRolls: [Math.min(...rolls)],
    });
  } else if (hasDisadvantage && !hasAdvantage) {
    const { result, rolls } = rollWithDisadvantage();
    attackRoll = result;
    diceRolls.push({
      type: 'attack',
      dice: '1d20',
      rolls,
      modifier: attackBonus,
      total: result + attackBonus,
      disadvantage: true,
      droppedRolls: [Math.max(...rolls)],
    });
  } else {
    attackRoll = rollD20();
    diceRolls.push({
      type: 'attack',
      dice: '1d20',
      rolls: [attackRoll],
      modifier: attackBonus,
      total: attackRoll + attackBonus,
    });
  }
  
  const totalAttack = attackRoll + attackBonus;
  const isCritical = attackRoll === 20 || defenseModifiers.autoCritical;
  const isCritMiss = attackRoll === 1;
  
  // Check if hit
  const isHit = !isCritMiss && (isCritical || totalAttack >= target.ac);
  
  let updatedTarget = target;
  let damageResult: { total: number; rolls: number[]; expression: string } | undefined;
  let description = '';
  
  if (isHit) {
    // Roll damage
    damageResult = rollDamage(damage.dice, isCritical);
    
    diceRolls.push({
      type: 'damage',
      dice: damage.dice,
      rolls: damageResult.rolls,
      modifier: 0, // Modifier is part of dice string
      total: damageResult.total,
    });
    
    // Apply damage
    const damageInstance: DamageInstance = {
      amount: damageResult.total,
      type: damage.type,
      source: attacker.name,
      isCritical,
      isMagical: options.isMagical,
    };
    
    const { combatant: afterDamage, result } = applyDamage(updatedTarget, damageInstance);
    updatedTarget = afterDamage;
    
    // Check and execute concentration save
    if (target.concentratingOn) {
      const { mustCheck, dc } = checkConcentration(target, result.finalAmount);
      if (mustCheck) {
        const conSave = rollD20();
        const conMod = updatedTarget.constitutionModifier ?? 0;
        const saveTotal = conSave + conMod;
        if (saveTotal >= dc) {
          description += ` ${target.name} makes a DC ${dc} Constitution save (${conSave}+${conMod}=${saveTotal}) and maintains concentration!`;
        } else {
          updatedTarget = breakConcentration(updatedTarget);
          description += ` ${target.name} fails a DC ${dc} Constitution save (${conSave}+${conMod}=${saveTotal}) and loses concentration on ${target.concentratingOn}!`;
        }
      }
    }
    
    if (isCritical) {
      description = `**CRITICAL HIT!** ${attacker.name} rolls ${totalAttack} to hit (natural 20!) and deals ${result.finalAmount} ${damage.type} damage to ${target.name}!`;
    } else {
      description = `${attacker.name} rolls ${totalAttack} to hit against AC ${target.ac} - HIT! Deals ${result.finalAmount} ${damage.type} damage to ${target.name}.`;
    }
    
    if (result.isDown) {
      description += ` ${target.name} falls unconscious!`;
    }
    if (result.instantKill) {
      description = description.replace('unconscious', 'dead from massive damage');
    }
  } else {
    if (isCritMiss) {
      description = `**CRITICAL MISS!** ${attacker.name} rolls a natural 1 - the attack goes completely wide!`;
    } else {
      description = `${attacker.name} rolls ${totalAttack} to hit against AC ${target.ac} - MISS!`;
    }
  }
  
  // Mark action as used and consume one-time conditions (helped_attack, hidden)
  const consumed = new Set(['helped_attack', 'hidden']);
  const updatedAttacker: Combatant = {
    ...attacker,
    turnResources: { ...attacker.turnResources, actionUsed: true },
    conditions: attacker.conditions.filter(c => !consumed.has(getCondName(c).toLowerCase())),
  };
  
  return {
    success: isHit,
    description,
    updatedCombatants: [updatedAttacker, updatedTarget],
    logEntry: {
      actorId: attacker.id,
      actorName: attacker.name,
      actionType: 'attack',
      actionDescription: `Attack vs ${target.name}`,
      targetIds: [target.id],
      targetNames: [target.name],
      diceRolls,
      damage: isHit && damageResult ? {
        amount: damageResult.total,
        type: damage.type,
        wasCritical: isCritical,
      } : undefined,
      outcome: isHit ? (isCritical ? 'Critical Hit!' : 'Hit') : (isCritMiss ? 'Critical Miss!' : 'Miss'),
    },
  };
}

/**
 * Execute the Dash action (double movement)
 */
export function executeDash(combatant: Combatant): ActionResult {
  const extraMovement = combatant.speed;
  
  const updatedCombatant: Combatant = {
    ...combatant,
    turnResources: {
      ...combatant.turnResources,
      actionUsed: true,
      movementRemaining: combatant.turnResources.movementRemaining + extraMovement,
    },
  };
  
  return {
    success: true,
    description: `${combatant.name} dashes, gaining ${extraMovement}ft of additional movement!`,
    updatedCombatants: [updatedCombatant],
    logEntry: {
      actorId: combatant.id,
      actorName: combatant.name,
      actionType: 'dash',
      actionDescription: `Dash (gains ${extraMovement}ft movement)`,
      outcome: `Movement increased by ${extraMovement}ft`,
    },
  };
}

/**
 * Execute the Disengage action (no opportunity attacks)
 */
export function executeDisengage(combatant: Combatant): ActionResult {
  const updatedCombatant: Combatant = {
    ...combatant,
    turnResources: {
      ...combatant.turnResources,
      actionUsed: true,
    },
    conditions: [
      ...combatant.conditions,
      {
        condition: 'disengaged' as ConditionName,
        name: 'Disengaged' as ConditionName,
        source: 'Disengage',
        duration: { type: 'turns', value: 1, endsAt: 'start_of_turn' },
      },
    ],
  };
  
  return {
    success: true,
    description: `${combatant.name} disengages, allowing movement without provoking opportunity attacks this turn.`,
    updatedCombatants: [updatedCombatant],
    logEntry: {
      actorId: combatant.id,
      actorName: combatant.name,
      actionType: 'disengage',
      actionDescription: 'Disengage',
      outcome: 'No opportunity attacks this turn',
    },
  };
}

/**
 * Execute the Dodge action (disadvantage on attacks against)
 */
export function executeDodge(combatant: Combatant): ActionResult {
  const updatedCombatant: Combatant = {
    ...combatant,
    turnResources: {
      ...combatant.turnResources,
      actionUsed: true,
    },
    conditions: [
      ...combatant.conditions,
      {
        condition: 'dodging' as ConditionName,
        name: 'Dodging' as ConditionName,
        source: 'Dodge',
        duration: { type: 'turns', value: 1, endsAt: 'start_of_turn' },
      },
    ],
  };
  
  return {
    success: true,
    description: `${combatant.name} focuses on dodging. Attack rolls against them have disadvantage, and they have advantage on Dexterity saving throws until their next turn.`,
    updatedCombatants: [updatedCombatant],
    logEntry: {
      actorId: combatant.id,
      actorName: combatant.name,
      actionType: 'dodge',
      actionDescription: 'Dodge',
      outcome: 'Attacks have disadvantage, advantage on DEX saves',
    },
  };
}

/**
 * Execute the Help action (give advantage to ally)
 */
export function executeHelp(
  helper: Combatant,
  target: Combatant,
  helpType: 'attack' | 'ability_check'
): ActionResult {
  const updatedHelper: Combatant = {
    ...helper,
    turnResources: {
      ...helper.turnResources,
      actionUsed: true,
    },
  };
  
  // Apply "helped" condition to the target so advantage can be checked during their action
  const conditionName = helpType === 'attack' ? 'helped_attack' : 'helped_check';
  const updatedTarget: Combatant = {
    ...target,
    conditions: [
      ...target.conditions,
      {
        condition: conditionName as ConditionName,
        name: conditionName as ConditionName,
        source: helper.name,
        duration: { type: 'turns', value: 1, endsAt: 'start_of_turn' },
      },
    ],
  };
  
  const description = helpType === 'attack'
    ? `${helper.name} helps ${target.name}, granting advantage on their next attack roll against a creature within 5 feet.`
    : `${helper.name} assists ${target.name}, granting advantage on their next ability check.`;
  
  return {
    success: true,
    description,
    updatedCombatants: [updatedHelper, updatedTarget],
    logEntry: {
      actorId: helper.id,
      actorName: helper.name,
      actionType: 'help',
      actionDescription: `Help ${target.name} (${helpType})`,
      targetIds: [target.id],
      targetNames: [target.name],
      outcome: `Grants advantage on ${helpType === 'attack' ? 'next attack' : 'next ability check'}`,
    },
  };
}

/**
 * Execute the Hide action
 * Checks stealth total against the highest passive perception of enemies.
 */
export function executeHide(
  combatant: Combatant,
  stealthRoll: number,
  stealthModifier: number,
  enemies?: Combatant[],
): ActionResult {
  const total = stealthRoll + stealthModifier;
  
  // Passive Perception = 10 + Wisdom modifier (PHB p.175)
  // If no enemies provided, use DC 12 as a reasonable default
  const highestPassivePerception = enemies && enemies.length > 0
    ? Math.max(...enemies.map(e => 10 + (e.wisdomModifier ?? 0)))
    : 12;
  
  const isHidden = total >= highestPassivePerception;
  
  const updatedCombatant: Combatant = {
    ...combatant,
    turnResources: {
      ...combatant.turnResources,
      actionUsed: true,
    },
    conditions: isHidden
      ? [
          ...combatant.conditions,
          {
            condition: 'hidden' as ConditionName,
            name: 'Hidden' as ConditionName,
            source: 'Hide',
            duration: { type: 'special', description: 'Until detected or attacks' },
          },
        ]
      : combatant.conditions,
  };
  
  const description = isHidden
    ? `${combatant.name} successfully hides! (Stealth ${total} vs Passive Perception ${highestPassivePerception})`
    : `${combatant.name} attempts to hide but is spotted! (Stealth ${total} vs Passive Perception ${highestPassivePerception})`;
  
  return {
    success: isHidden,
    description,
    updatedCombatants: [updatedCombatant],
    logEntry: {
      actorId: combatant.id,
      actorName: combatant.name,
      actionType: 'hide',
      actionDescription: 'Hide',
      diceRolls: [{
        type: 'stealth',
        dice: '1d20',
        rolls: [stealthRoll],
        modifier: stealthModifier,
        total,
      }],
      outcome: isHidden ? `Hidden (Stealth: ${total})` : `Spotted (Stealth: ${total})`,
    },
  };
}

/**
 * Execute the Ready action (prepare action for trigger)
 * Stores the readied action as a condition so the system can track it.
 */
export function executeReady(
  combatant: Combatant,
  trigger: string,
  readiedAction: string
): ActionResult {
  const updatedCombatant: Combatant = {
    ...combatant,
    turnResources: {
      ...combatant.turnResources,
      actionUsed: true,
    },
    conditions: [
      ...combatant.conditions,
      {
        condition: 'readied' as ConditionName,
        name: 'Readied' as ConditionName,
        source: `Trigger: ${trigger} | Action: ${readiedAction}`,
        duration: { type: 'turns', value: 1, endsAt: 'start_of_turn' },
      },
    ],
  };
  
  return {
    success: true,
    description: `${combatant.name} readies an action: "${readiedAction}" when "${trigger}".`,
    updatedCombatants: [updatedCombatant],
    logEntry: {
      actorId: combatant.id,
      actorName: combatant.name,
      actionType: 'ready',
      actionDescription: `Ready: ${readiedAction}`,
      outcome: `Trigger: ${trigger}`,
    },
  };
}

/**
 * Execute the Search action
 */
export function executeSearch(
  combatant: Combatant,
  perceptionRoll: number,
  perceptionModifier: number
): ActionResult {
  const total = perceptionRoll + perceptionModifier;
  
  const updatedCombatant: Combatant = {
    ...combatant,
    turnResources: {
      ...combatant.turnResources,
      actionUsed: true,
    },
  };
  
  return {
    success: true,
    description: `${combatant.name} searches the area, rolling ${total} on their Perception check (${perceptionRoll} + ${perceptionModifier}).`,
    updatedCombatants: [updatedCombatant],
    logEntry: {
      actorId: combatant.id,
      actorName: combatant.name,
      actionType: 'search',
      actionDescription: 'Search',
      diceRolls: [{
        type: 'perception',
        dice: '1d20',
        rolls: [perceptionRoll],
        modifier: perceptionModifier,
        total,
      }],
      outcome: `Perception: ${total}`,
    },
  };
}

/**
 * Execute a grapple attempt
 */
export function executeGrapple(
  attacker: Combatant,
  target: Combatant,
  attackerAthleticsModifier: number,
  targetAthleticsModifier: number,
  targetAcrobaticsModifier: number
): ActionResult {
  // Check size - can't grapple creatures more than one size larger
  // This would need size data from the full character/monster
  
  // Attacker rolls Athletics
  const attackerRoll = rollD20();
  const attackerTotal = attackerRoll + attackerAthleticsModifier;
  
  // Target chooses Athletics or Acrobatics
  const targetRoll = rollD20();
  const targetUsesAthletics = targetAthleticsModifier >= targetAcrobaticsModifier;
  const targetModifier = targetUsesAthletics ? targetAthleticsModifier : targetAcrobaticsModifier;
  const targetTotal = targetRoll + targetModifier;
  
  const success = attackerTotal > targetTotal;
  
  let updatedTarget = target;
  if (success) {
    updatedTarget = applyCondition(
      target,
      'Grappled',
      attacker.name,
      { type: 'permanent' }
    );
  }
  
  const updatedAttacker: Combatant = {
    ...attacker,
    turnResources: {
      ...attacker.turnResources,
      actionUsed: true,
    },
  };
  
  const targetSkill = targetUsesAthletics ? 'athletics' : 'acrobatics';
  
  return {
    success,
    description: success
      ? `${attacker.name} grapples ${target.name}! (Athletics ${attackerTotal} vs ${targetSkill} ${targetTotal})`
      : `${target.name} escapes ${attacker.name}'s grapple attempt! (Athletics ${attackerTotal} vs ${targetSkill} ${targetTotal})`,
    updatedCombatants: [updatedAttacker, updatedTarget],
    logEntry: {
      actorId: attacker.id,
      actorName: attacker.name,
      actionType: 'grapple',
      actionDescription: `Grapple ${target.name}`,
      targetIds: [target.id],
      targetNames: [target.name],
      diceRolls: [
        {
          type: 'athletics',
          dice: '1d20',
          rolls: [attackerRoll],
          modifier: attackerAthleticsModifier,
          total: attackerTotal,
        },
        {
          type: targetSkill.toLowerCase(),
          dice: '1d20',
          rolls: [targetRoll],
          modifier: targetModifier,
          total: targetTotal,
        },
      ],
      conditionsApplied: success ? ['Grappled'] : undefined,
      outcome: success ? 'Grappled!' : 'Escaped!',
    },
  };
}

/**
 * Execute a shove attempt
 */
export function executeShove(
  attacker: Combatant,
  target: Combatant,
  attackerAthleticsModifier: number,
  targetAthleticsModifier: number,
  targetAcrobaticsModifier: number,
  knockProne: boolean = true // false = push away
): ActionResult {
  // Attacker rolls Athletics
  const attackerRoll = rollD20();
  const attackerTotal = attackerRoll + attackerAthleticsModifier;
  
  // Target chooses Athletics or Acrobatics
  const targetRoll = rollD20();
  const targetUsesAthletics = targetAthleticsModifier >= targetAcrobaticsModifier;
  const targetModifier = targetUsesAthletics ? targetAthleticsModifier : targetAcrobaticsModifier;
  const targetTotal = targetRoll + targetModifier;
  
  const success = attackerTotal > targetTotal;
  
  let updatedTarget = target;
  if (success && knockProne) {
    updatedTarget = applyCondition(
      target,
      'Prone',
      attacker.name,
      { type: 'permanent' }
    );
  }
  // If pushing, would need to update position
  
  const updatedAttacker: Combatant = {
    ...attacker,
    turnResources: {
      ...attacker.turnResources,
      actionUsed: true,
    },
  };
  
  const effect = knockProne ? 'knocked prone' : 'pushed 5 feet';
  const targetSkill = targetUsesAthletics ? 'athletics' : 'acrobatics';
  
  return {
    success,
    description: success
      ? `${attacker.name} shoves ${target.name} and they are ${effect}! (Athletics ${attackerTotal} vs ${targetSkill} ${targetTotal})`
      : `${target.name} resists ${attacker.name}'s shove! (Athletics ${attackerTotal} vs ${targetSkill} ${targetTotal})`,
    updatedCombatants: [updatedAttacker, updatedTarget],
    logEntry: {
      actorId: attacker.id,
      actorName: attacker.name,
      actionType: 'shove',
      actionDescription: `Shove ${target.name} (${knockProne ? 'prone' : 'push'})`,
      targetIds: [target.id],
      targetNames: [target.name],
      diceRolls: [
        {
          type: 'athletics',
          dice: '1d20',
          rolls: [attackerRoll],
          modifier: attackerAthleticsModifier,
          total: attackerTotal,
        },
        {
          type: targetSkill.toLowerCase(),
          dice: '1d20',
          rolls: [targetRoll],
          modifier: targetModifier,
          total: targetTotal,
        },
      ],
      conditionsApplied: success && knockProne ? ['Prone'] : undefined,
      outcome: success ? effect : 'Resisted',
    },
  };
}

/**
 * Execute a death saving throw
 */
export function executeDeathSave(combatant: Combatant): ActionResult {
  if (combatant.hp.current > 0 || !combatant.deathSaves) {
    return {
      success: false,
      description: `${combatant.name} doesn't need to make a death save.`,
      updatedCombatants: [combatant],
      logEntry: {
        actorId: combatant.id,
        actorName: combatant.name,
        actionType: 'death_save',
        actionDescription: 'Death Save (not needed)',
        outcome: 'Not at 0 HP',
      },
    };
  }
  
  const roll = rollD20();
  
  let updatedCombatant = { ...combatant };
  let outcome = '';
  let description = '';
  
  if (roll === 20) {
    // Natural 20: regain 1 HP
    updatedCombatant.hp.current = 1;
    updatedCombatant.deathSaves = { successes: 0, failures: 0 };
    updatedCombatant.conditions = updatedCombatant.conditions.filter(c => c.condition?.toLowerCase() !== 'unconscious');
    outcome = 'Natural 20! Regains consciousness!';
    description = `**NATURAL 20!** ${combatant.name} regains consciousness with 1 HP!`;
  } else if (roll === 1) {
    // Natural 1: 2 failures
    updatedCombatant.deathSaves = {
      ...updatedCombatant.deathSaves!,
      failures: Math.min(3, updatedCombatant.deathSaves!.failures + 2),
    };
    outcome = 'Natural 1! Two failures!';
    description = `**NATURAL 1!** ${combatant.name} suffers two death save failures! (${updatedCombatant.deathSaves!.successes}✓/${updatedCombatant.deathSaves!.failures}✗)`;
  } else if (roll >= 10) {
    // Success
    updatedCombatant.deathSaves = {
      ...updatedCombatant.deathSaves!,
      successes: updatedCombatant.deathSaves!.successes + 1,
    };
    
    if (updatedCombatant.deathSaves!.successes >= 3) {
      // Stabilized
      outcome = 'Success (3)! Stabilized!';
      description = `${combatant.name} rolls ${roll} - SUCCESS! They have stabilized! (${updatedCombatant.deathSaves!.successes}✓/${updatedCombatant.deathSaves!.failures}✗)`;
    } else {
      outcome = `Success (${updatedCombatant.deathSaves!.successes}/3)`;
      description = `${combatant.name} rolls ${roll} - SUCCESS! (${updatedCombatant.deathSaves!.successes}✓/${updatedCombatant.deathSaves!.failures}✗)`;
    }
  } else {
    // Failure
    updatedCombatant.deathSaves = {
      ...updatedCombatant.deathSaves!,
      failures: updatedCombatant.deathSaves!.failures + 1,
    };
    
    if (updatedCombatant.deathSaves!.failures >= 3) {
      // Dead
      outcome = 'Failure (3)! DEAD!';
      description = `${combatant.name} rolls ${roll} - FAILURE! **${combatant.name} has died!** (${updatedCombatant.deathSaves!.successes}✓/${updatedCombatant.deathSaves!.failures}✗)`;
    } else {
      outcome = `Failure (${updatedCombatant.deathSaves!.failures}/3)`;
      description = `${combatant.name} rolls ${roll} - FAILURE! (${updatedCombatant.deathSaves!.successes}✓/${updatedCombatant.deathSaves!.failures}✗)`;
    }
  }
  
  return {
    success: roll >= 10,
    description,
    updatedCombatants: [updatedCombatant],
    logEntry: {
      actorId: combatant.id,
      actorName: combatant.name,
      actionType: 'death_save',
      actionDescription: 'Death Saving Throw',
      diceRolls: [{
        type: 'death_save',
        dice: '1d20',
        rolls: [roll],
        modifier: 0,
        total: roll,
      }],
      outcome,
    },
  };
}

/**
 * Execute movement
 */
export function executeMovement(
  combatant: Combatant,
  distance: number,
  newPosition?: { x: number; y: number }
): ActionResult {
  if (distance > combatant.turnResources.movementRemaining) {
    return {
      success: false,
      description: `${combatant.name} doesn't have enough movement remaining (${combatant.turnResources.movementRemaining}ft).`,
      updatedCombatants: [combatant],
      logEntry: {
        actorId: combatant.id,
        actorName: combatant.name,
        actionType: 'movement',
        actionDescription: `Move ${distance}ft (failed)`,
        outcome: 'Not enough movement',
      },
    };
  }
  
  const updatedCombatant: Combatant = {
    ...combatant,
    turnResources: {
      ...combatant.turnResources,
      movementRemaining: combatant.turnResources.movementRemaining - distance,
    },
    position: newPosition || combatant.position,
  };
  
  return {
    success: true,
    description: `${combatant.name} moves ${distance}ft (${updatedCombatant.turnResources.movementRemaining}ft remaining).`,
    updatedCombatants: [updatedCombatant],
    logEntry: {
      actorId: combatant.id,
      actorName: combatant.name,
      actionType: 'movement',
      actionDescription: `Move ${distance}ft`,
      outcome: `${updatedCombatant.turnResources.movementRemaining}ft remaining`,
    },
  };
}

/**
 * Stand up from prone (costs half movement)
 */
export function executeStandUp(combatant: Combatant): ActionResult {
  if (!hasCondition(combatant, 'Prone')) {
    return {
      success: false,
      description: `${combatant.name} is not prone.`,
      updatedCombatants: [combatant],
      logEntry: {
        actorId: combatant.id,
        actorName: combatant.name,
        actionType: 'movement',
        actionDescription: 'Stand up (not prone)',
        outcome: 'Not prone',
      },
    };
  }
  
  const standCost = Math.floor(combatant.speed / 2);
  
  if (combatant.turnResources.movementRemaining < standCost) {
    return {
      success: false,
      description: `${combatant.name} doesn't have enough movement to stand up (needs ${standCost}ft).`,
      updatedCombatants: [combatant],
      logEntry: {
        actorId: combatant.id,
        actorName: combatant.name,
        actionType: 'movement',
        actionDescription: 'Stand up (failed)',
        outcome: `Needs ${standCost}ft movement`,
      },
    };
  }
  
  let updatedCombatant = removeCondition(combatant, 'Prone');
  updatedCombatant = {
    ...updatedCombatant,
    turnResources: {
      ...updatedCombatant.turnResources,
      movementRemaining: updatedCombatant.turnResources.movementRemaining - standCost,
    },
  };
  
  return {
    success: true,
    description: `${combatant.name} stands up, using ${standCost}ft of movement.`,
    updatedCombatants: [updatedCombatant],
    logEntry: {
      actorId: combatant.id,
      actorName: combatant.name,
      actionType: 'movement',
      actionDescription: `Stand up (${standCost}ft)`,
      conditionsRemoved: ['Prone'],
      outcome: 'No longer prone',
    },
  };
}
