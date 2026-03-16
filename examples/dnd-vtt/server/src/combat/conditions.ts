/**
 * Condition Management
 * Handles applying, removing, and tracking conditions
 */

import type { Combatant } from './combat-state';
import type { 
  ConditionName, 
  ActiveCondition, 
  ConditionDuration,
  AbilityName,
} from '../types';

/**
 * Full condition definitions per D&D 5e SRD
 */
export interface ConditionDefinition {
  name: ConditionName;
  description: string;
  effects: ConditionEffect[];
}

export interface ConditionEffect {
  type: 'advantage' | 'disadvantage' | 'auto_fail' | 'auto_succeed' | 
        'speed_modifier' | 'cant_take_action' | 'cant_move' | 'other';
  target?: 'attack_rolls' | 'ability_checks' | 'saving_throws' | string;
  ability?: AbilityName;
  value?: number;
  description?: string;
}

/**
 * SRD Condition Definitions
 */
export const CONDITIONS: Partial<Record<ConditionName, ConditionDefinition>> = {
  Blinded: {
    name: 'Blinded',
    description: 'A blinded creature can\'t see and automatically fails any ability check that requires sight.',
    effects: [
      { type: 'auto_fail', target: 'ability_checks', description: 'Fails checks requiring sight' },
      { type: 'disadvantage', target: 'attack_rolls' },
      { type: 'advantage', target: 'attack_rolls', description: 'Attacks against have advantage' },
    ],
  },
  Charmed: {
    name: 'Charmed',
    description: 'A charmed creature can\'t attack the charmer or target them with harmful abilities or magical effects.',
    effects: [
      { type: 'other', description: 'Can\'t attack or harm the charmer' },
      { type: 'advantage', target: 'ability_checks', description: 'Charmer has advantage on social checks' },
    ],
  },
  Deafened: {
    name: 'Deafened',
    description: 'A deafened creature can\'t hear and automatically fails any ability check that requires hearing.',
    effects: [
      { type: 'auto_fail', target: 'ability_checks', description: 'Fails checks requiring hearing' },
    ],
  },
  Frightened: {
    name: 'Frightened',
    description: 'A frightened creature has disadvantage on ability checks and attack rolls while the source of fear is within line of sight.',
    effects: [
      { type: 'disadvantage', target: 'ability_checks', description: 'While source is visible' },
      { type: 'disadvantage', target: 'attack_rolls', description: 'While source is visible' },
      { type: 'other', description: 'Can\'t willingly move closer to source' },
    ],
  },
  Grappled: {
    name: 'Grappled',
    description: 'A grappled creature\'s speed becomes 0, and it can\'t benefit from any bonus to its speed.',
    effects: [
      { type: 'speed_modifier', value: 0, description: 'Speed becomes 0' },
    ],
  },
  Incapacitated: {
    name: 'Incapacitated',
    description: 'An incapacitated creature can\'t take actions or reactions.',
    effects: [
      { type: 'cant_take_action' },
      { type: 'other', description: 'Can\'t take reactions' },
    ],
  },
  Invisible: {
    name: 'Invisible',
    description: 'An invisible creature is impossible to see without the aid of magic or a special sense.',
    effects: [
      { type: 'advantage', target: 'attack_rolls' },
      { type: 'disadvantage', target: 'attack_rolls', description: 'Attacks against have disadvantage' },
    ],
  },
  Paralyzed: {
    name: 'Paralyzed',
    description: 'A paralyzed creature is incapacitated and can\'t move or speak.',
    effects: [
      { type: 'cant_take_action' },
      { type: 'cant_move' },
      { type: 'auto_fail', target: 'saving_throws', ability: 'strength' },
      { type: 'auto_fail', target: 'saving_throws', ability: 'dexterity' },
      { type: 'advantage', target: 'attack_rolls', description: 'Attacks against have advantage' },
      { type: 'other', description: 'Attacks from within 5ft are automatic criticals' },
    ],
  },
  Petrified: {
    name: 'Petrified',
    description: 'A petrified creature is transformed into a solid inanimate substance.',
    effects: [
      { type: 'cant_take_action' },
      { type: 'cant_move' },
      { type: 'auto_fail', target: 'saving_throws', ability: 'strength' },
      { type: 'auto_fail', target: 'saving_throws', ability: 'dexterity' },
      { type: 'other', description: 'Resistance to all damage' },
      { type: 'other', description: 'Immune to poison and disease' },
    ],
  },
  Poisoned: {
    name: 'Poisoned',
    description: 'A poisoned creature has disadvantage on attack rolls and ability checks.',
    effects: [
      { type: 'disadvantage', target: 'attack_rolls' },
      { type: 'disadvantage', target: 'ability_checks' },
    ],
  },
  Prone: {
    name: 'Prone',
    description: 'A prone creature\'s only movement option is to crawl. Standing up costs half movement.',
    effects: [
      { type: 'disadvantage', target: 'attack_rolls' },
      { type: 'advantage', target: 'attack_rolls', description: 'Melee attacks within 5ft have advantage' },
      { type: 'disadvantage', target: 'attack_rolls', description: 'Ranged attacks have disadvantage' },
      { type: 'other', description: 'Standing up costs half movement' },
    ],
  },
  Restrained: {
    name: 'Restrained',
    description: 'A restrained creature\'s speed becomes 0 and it can\'t benefit from any bonus to its speed.',
    effects: [
      { type: 'speed_modifier', value: 0 },
      { type: 'disadvantage', target: 'attack_rolls' },
      { type: 'disadvantage', target: 'saving_throws', ability: 'dexterity' },
      { type: 'advantage', target: 'attack_rolls', description: 'Attacks against have advantage' },
    ],
  },
  Stunned: {
    name: 'Stunned',
    description: 'A stunned creature is incapacitated, can\'t move, and can speak only falteringly.',
    effects: [
      { type: 'cant_take_action' },
      { type: 'cant_move' },
      { type: 'auto_fail', target: 'saving_throws', ability: 'strength' },
      { type: 'auto_fail', target: 'saving_throws', ability: 'dexterity' },
      { type: 'advantage', target: 'attack_rolls', description: 'Attacks against have advantage' },
    ],
  },
  Unconscious: {
    name: 'Unconscious',
    description: 'An unconscious creature is incapacitated, can\'t move or speak, and is unaware of its surroundings.',
    effects: [
      { type: 'cant_take_action' },
      { type: 'cant_move' },
      { type: 'other', description: 'Drops held items and falls prone' },
      { type: 'auto_fail', target: 'saving_throws', ability: 'strength' },
      { type: 'auto_fail', target: 'saving_throws', ability: 'dexterity' },
      { type: 'advantage', target: 'attack_rolls', description: 'Attacks against have advantage' },
      { type: 'other', description: 'Attacks from within 5ft are automatic criticals' },
    ],
  },
  Exhaustion: {
    name: 'Exhaustion',
    description: 'Exhaustion is measured in six levels with cumulative effects.',
    effects: [
      { type: 'other', description: 'Level 1: Disadvantage on ability checks' },
      { type: 'other', description: 'Level 2: Speed halved' },
      { type: 'other', description: 'Level 3: Disadvantage on attacks and saves' },
      { type: 'other', description: 'Level 4: HP maximum halved' },
      { type: 'other', description: 'Level 5: Speed reduced to 0' },
      { type: 'other', description: 'Level 6: Death' },
    ],
  },
};

/**
 * Apply a condition to a combatant
 */
export function applyCondition(
  combatant: Combatant,
  conditionName: ConditionName,
  source: string,
  duration: ConditionDuration,
  saveInfo?: { dc: number; ability: AbilityName; endOfTurn?: boolean }
): Combatant {
  // Check if already has this condition
  const existingIndex = combatant.conditions.findIndex(c => c.name === conditionName);
  
  const newCondition: ActiveCondition = {
    name: conditionName,
    source,
    duration,
    saveInfo,
    appliedAt: new Date(),
  };
  
  let updatedConditions: ActiveCondition[];
  
  if (existingIndex >= 0) {
    // Replace existing condition if new one has longer duration
    const existing = combatant.conditions[existingIndex];
    const shouldReplace = typeof existing.duration === 'object' && 'type' in existing.duration && isConditionDuration(existing.duration)
      ? compareDurations(duration, existing.duration) > 0
      : true; // Replace if existing duration is not a standard ConditionDuration
    
    if (shouldReplace) {
      updatedConditions = [...combatant.conditions];
      updatedConditions[existingIndex] = newCondition;
    } else {
      updatedConditions = combatant.conditions;
    }
  } else {
    updatedConditions = [...combatant.conditions, newCondition];
  }
  
  // Handle special condition interactions
  updatedConditions = handleConditionInteractions(updatedConditions, conditionName);
  
  return {
    ...combatant,
    conditions: updatedConditions,
  };
}

/**
 * Remove a condition from a combatant
 */
export function removeCondition(
  combatant: Combatant,
  conditionName: ConditionName
): Combatant {
  return {
    ...combatant,
    conditions: combatant.conditions.filter(c => c.name !== conditionName),
  };
}

/**
 * Remove conditions from a specific source
 */
export function removeConditionsFromSource(
  combatant: Combatant,
  source: string
): Combatant {
  return {
    ...combatant,
    conditions: combatant.conditions.filter(c => c.source !== source),
  };
}

/**
 * Check if a combatant has a specific condition
 */
export function hasCondition(combatant: Combatant, conditionName: ConditionName): boolean {
  return combatant.conditions.some(c => c.name === conditionName);
}

/**
 * Get exhaution level (0-6)
 */
export function getExhaustionLevel(combatant: Combatant): number {
  const exhaustion = combatant.conditions.find(c => c.name === 'Exhaustion');
  return exhaustion?.level || 0;
}

/**
 * Add exhaustion level
 */
export function addExhaustion(combatant: Combatant, levels: number = 1): Combatant {
  const currentLevel = getExhaustionLevel(combatant);
  const newLevel = Math.min(6, currentLevel + levels);
  
  if (currentLevel === 0) {
    // Add new exhaustion condition
    return applyCondition(
      combatant,
      'Exhaustion',
      'Exhaustion',
      { type: 'permanent' },
    );
  }
  
  // Update existing exhaustion level
  return {
    ...combatant,
    conditions: combatant.conditions.map(c => 
      c.name === 'Exhaustion' 
        ? { ...c, level: newLevel }
        : c
    ),
  };
}

/**
 * Reduce exhaustion level
 */
export function reduceExhaustion(combatant: Combatant, levels: number = 1): Combatant {
  const currentLevel = getExhaustionLevel(combatant);
  const newLevel = Math.max(0, currentLevel - levels);
  
  if (newLevel === 0) {
    return removeCondition(combatant, 'Exhaustion');
  }
  
  return {
    ...combatant,
    conditions: combatant.conditions.map(c =>
      c.name === 'Exhaustion'
        ? { ...c, level: newLevel }
        : c
    ),
  };
}

/**
 * Get all effects that apply to attack rolls
 */
export function getAttackModifiers(combatant: Combatant): {
  hasAdvantage: boolean;
  hasDisadvantage: boolean;
  autoFail: boolean;
} {
  let hasAdvantage = false;
  let hasDisadvantage = false;
  let autoFail = false;
  
  for (const condition of combatant.conditions) {
    const condName = condition.condition ?? condition.name;
    const definition = condName ? CONDITIONS[condName] : undefined;
    if (!definition) continue; // Skip custom/non-standard conditions
    
    for (const effect of definition.effects) {
      if (effect.target === 'attack_rolls') {
        if (effect.type === 'advantage') {
          // This is usually for attacks AGAINST the creature
        } else if (effect.type === 'disadvantage') {
          hasDisadvantage = true;
        } else if (effect.type === 'auto_fail') {
          autoFail = true;
        }
      }
    }
  }
  
  // Invisible gives advantage on attacks
  if (hasCondition(combatant, 'Invisible')) {
    hasAdvantage = true;
  }
  
  return { hasAdvantage, hasDisadvantage, autoFail };
}

/**
 * Get modifiers for attacks against this combatant
 */
export function getDefenseModifiers(combatant: Combatant, attackerDistance: number = 5): {
  attackerHasAdvantage: boolean;
  attackerHasDisadvantage: boolean;
  autoCritical: boolean;
} {
  let attackerHasAdvantage = false;
  let attackerHasDisadvantage = false;
  let autoCritical = false;
  
  // Unconscious, paralyzed - advantage and auto-crit at 5ft
  if (hasCondition(combatant, 'Unconscious') || hasCondition(combatant, 'Paralyzed')) {
    attackerHasAdvantage = true;
    if (attackerDistance <= 5) {
      autoCritical = true;
    }
  }
  
  // Stunned, restrained - advantage
  if (hasCondition(combatant, 'Stunned') || hasCondition(combatant, 'Restrained')) {
    attackerHasAdvantage = true;
  }
  
  // Blinded - advantage against
  if (hasCondition(combatant, 'Blinded')) {
    attackerHasAdvantage = true;
  }
  
  // Invisible - disadvantage against
  if (hasCondition(combatant, 'Invisible')) {
    attackerHasDisadvantage = true;
  }
  
  // Prone - advantage for melee, disadvantage for ranged
  if (hasCondition(combatant, 'Prone')) {
    if (attackerDistance <= 5) {
      attackerHasAdvantage = true;
    } else {
      attackerHasDisadvantage = true;
    }
  }
  
  return { attackerHasAdvantage, attackerHasDisadvantage, autoCritical };
}

/**
 * Check saving throw modifiers from conditions
 */
export function getSaveModifiers(
  combatant: Combatant,
  ability: AbilityName
): {
  hasAdvantage: boolean;
  hasDisadvantage: boolean;
  autoFail: boolean;
} {
  let hasAdvantage = false;
  let hasDisadvantage = false;
  let autoFail = false;
  
  for (const condition of combatant.conditions) {
    const condName = condition.condition ?? condition.name;
    const definition = condName ? CONDITIONS[condName] : undefined;
    if (!definition) continue;
    
    for (const effect of definition.effects) {
      if (effect.target === 'saving_throws' && 
          (effect.ability === ability || effect.ability === undefined)) {
        if (effect.type === 'advantage') {
          hasAdvantage = true;
        } else if (effect.type === 'disadvantage') {
          hasDisadvantage = true;
        } else if (effect.type === 'auto_fail') {
          autoFail = true;
        }
      }
    }
  }
  
  // Check exhaustion level 3+
  const exhaustionLevel = getExhaustionLevel(combatant);
  if (exhaustionLevel >= 3) {
    hasDisadvantage = true;
  }
  
  return { hasAdvantage, hasDisadvantage, autoFail };
}

/**
 * Compare two durations (returns positive if a > b)
 */
function compareDurations(a: ConditionDuration, b: ConditionDuration): number {
  // Permanent > hours > minutes > rounds > turns > until_save/until_dispelled
  const typeOrder: Record<string, number> = {
    permanent: 5,
    until_dispelled: 4,
    hours: 4,
    minutes: 3,
    rounds: 2,
    turns: 1,
    until_save: 1,
  };
  
  const aOrder = typeOrder[a.type] ?? 0;
  const bOrder = typeOrder[b.type] ?? 0;
  
  if (aOrder !== bOrder) {
    return aOrder - bOrder;
  }
  
  // Same type - compare remaining
  const aRemaining = a.roundsRemaining ?? 0;
  const bRemaining = b.roundsRemaining ?? 0;
  
  return aRemaining - bRemaining;
}

/** Type guard to check if a duration object is a ConditionDuration */
function isConditionDuration(duration: object): duration is ConditionDuration {
  if (!('type' in duration)) return false;
  const validTypes = ['rounds', 'turns', 'minutes', 'hours', 'permanent', 'until_save', 'until_dispelled'];
  return validTypes.includes((duration as ConditionDuration).type);
}

/**
 * Handle special condition interactions
 */
function handleConditionInteractions(
  conditions: ActiveCondition[],
  newCondition: ConditionName
): ActiveCondition[] {
  // Paralyzed includes incapacitated
  if (newCondition === 'Paralyzed') {
    conditions = conditions.filter(c => c.name !== 'Incapacitated');
  }
  
  // Stunned includes incapacitated
  if (newCondition === 'Stunned') {
    conditions = conditions.filter(c => c.name !== 'Incapacitated');
  }
  
  // Unconscious includes incapacitated and prone
  if (newCondition === 'Unconscious') {
    conditions = conditions.filter(c => 
      c.name !== 'Incapacitated' && c.name !== 'Prone'
    );
    // Auto-add prone
    if (!conditions.some(c => c.name === 'Prone')) {
      conditions.push({
        name: 'Prone',
        source: 'Unconscious',
        duration: { type: 'special', description: 'Until no longer unconscious' },
      });
    }
  }
  
  // Petrified includes incapacitated
  if (newCondition === 'Petrified') {
    conditions = conditions.filter(c => c.name !== 'Incapacitated');
  }
  
  return conditions;
}

/**
 * Get a narrative description of a condition being applied
 */
export function describeConditionApplied(
  targetName: string,
  conditionName: ConditionName
): string {
  const descriptions: Partial<Record<ConditionName, string>> = {
    Blinded: `${targetName}'s vision goes dark - they are blinded!`,
    Charmed: `${targetName}'s expression softens - they are charmed!`,
    Deafened: `${targetName}'s ears ring with silence - they are deafened!`,
    Frightened: `Fear grips ${targetName} - they are frightened!`,
    Grappled: `${targetName} is grabbed and held - they are grappled!`,
    Incapacitated: `${targetName} is rendered helpless - they are incapacitated!`,
    Invisible: `${targetName} fades from view - they are invisible!`,
    Paralyzed: `${targetName}'s muscles lock up - they are paralyzed!`,
    Petrified: `${targetName} turns to stone - they are petrified!`,
    Poisoned: `${targetName} feels sick - they are poisoned!`,
    Prone: `${targetName} falls to the ground - they are prone!`,
    Restrained: `${targetName} is bound tight - they are restrained!`,
    Stunned: `${targetName} reels in shock - they are stunned!`,
    Unconscious: `${targetName} collapses - they are unconscious!`,
    Exhaustion: `${targetName} grows weary - they gain exhaustion!`,
  };
  
  return descriptions[conditionName] || `${targetName} is affected by ${conditionName}!`;
}
