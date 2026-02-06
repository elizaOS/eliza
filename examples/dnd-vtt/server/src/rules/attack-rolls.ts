/**
 * Attack Roll Rules
 * D&D 5e attack resolution including melee, ranged, and spell attacks
 */

import {
  type AbilityName,
  type AbilityScores,
  type CharacterSheet,
  type Monster,
  type ActiveCondition,
  type DamageType,
  type DamageModifiers,
  calculateModifier,
  getProficiencyBonus,
  executeDiceRoll,
  parseDiceNotation,
  calculateFinalDamage,
  CONDITIONS,
} from '../types';

export type AttackType = 'melee_weapon' | 'ranged_weapon' | 'melee_spell' | 'ranged_spell';

export interface AttackParams {
  attacker: CharacterSheet | Monster;
  attackerType: 'character' | 'monster';
  target: CharacterSheet | Monster;
  targetType: 'character' | 'monster';
  attackType: AttackType;
  weaponBonus?: number;
  damageNotation: string;
  damageType: DamageType;
  additionalDamage?: Array<{ notation: string; type: DamageType }>;
  advantage?: boolean;
  disadvantage?: boolean;
  attackerConditions?: ActiveCondition[];
  targetConditions?: ActiveCondition[];
  coverBonus?: number;
  rangeCategory?: 'normal' | 'long';
}

export interface AttackResult {
  hit: boolean;
  critical: boolean;
  criticalMiss: boolean;
  attackRoll: number;
  naturalRoll: number;
  attackBonus: number;
  targetAC: number;
  damage: number;
  damageType: DamageType;
  totalDamage: number;
  damageBreakdown: Array<{
    type: DamageType;
    baseDamage: number;
    finalDamage: number;
    modifier: 'normal' | 'resistant' | 'immune' | 'vulnerable';
  }>;
  description: string;
}

/**
 * Get attack modifier conditions for attacker
 */
function getAttackerConditionModifiers(
  conditions: ActiveCondition[],
  attackType: AttackType
): { grantsAdvantage: boolean; grantsDisadvantage: boolean; autoCrit: boolean } {
  let grantsAdvantage = false;
  let grantsDisadvantage = false;
  let autoCrit = false;
  
  for (const active of conditions) {
    const conditionDef = CONDITIONS[active.condition];
    if (!conditionDef) continue;
    
    // Blinded - disadvantage on attack rolls
    if (active.condition === 'Blinded') {
      grantsDisadvantage = true;
    }
    
    // Frightened - disadvantage if source is in sight (simplified to always)
    if (active.condition === 'Frightened') {
      grantsDisadvantage = true;
    }
    
    // Poisoned - disadvantage on attack rolls
    if (active.condition === 'Poisoned') {
      grantsDisadvantage = true;
    }
    
    // Prone - disadvantage on attack rolls
    if (active.condition === 'Prone') {
      grantsDisadvantage = true;
    }
    
    // Restrained - disadvantage on attack rolls
    if (active.condition === 'Restrained') {
      grantsDisadvantage = true;
    }
    
    // Exhaustion level 3+ - disadvantage on attack rolls
    if (active.condition === 'Exhaustion' && (active.stacks || 1) >= 3) {
      grantsDisadvantage = true;
    }
    
    // Invisible - advantage on attack rolls
    if (active.condition === 'Invisible') {
      grantsAdvantage = true;
    }
  }
  
  return { grantsAdvantage, grantsDisadvantage, autoCrit };
}

/**
 * Get defense modifier conditions for target
 */
function getTargetConditionModifiers(
  conditions: ActiveCondition[],
  attackType: AttackType,
  isAdjacent: boolean = true
): { grantsAdvantageToAttacker: boolean; grantsDisadvantageToAttacker: boolean; autoHit: boolean; autoCrit: boolean } {
  let grantsAdvantageToAttacker = false;
  let grantsDisadvantageToAttacker = false;
  let autoHit = false;
  let autoCrit = false;
  
  const isMelee = attackType === 'melee_weapon' || attackType === 'melee_spell';
  const isRanged = attackType === 'ranged_weapon' || attackType === 'ranged_spell';
  
  for (const active of conditions) {
    // Blinded - attacks against have advantage
    if (active.condition === 'Blinded') {
      grantsAdvantageToAttacker = true;
    }
    
    // Invisible - attacks against have disadvantage
    if (active.condition === 'Invisible') {
      grantsDisadvantageToAttacker = true;
    }
    
    // Paralyzed - attacks have advantage, auto-crit if within 5 feet
    if (active.condition === 'Paralyzed') {
      grantsAdvantageToAttacker = true;
      if (isMelee && isAdjacent) {
        autoCrit = true;
      }
    }
    
    // Petrified - attacks have advantage
    if (active.condition === 'Petrified') {
      grantsAdvantageToAttacker = true;
    }
    
    // Prone - melee has advantage, ranged has disadvantage
    if (active.condition === 'Prone') {
      if (isMelee && isAdjacent) {
        grantsAdvantageToAttacker = true;
      } else if (isRanged) {
        grantsDisadvantageToAttacker = true;
      }
    }
    
    // Restrained - attacks have advantage
    if (active.condition === 'Restrained') {
      grantsAdvantageToAttacker = true;
    }
    
    // Stunned - attacks have advantage
    if (active.condition === 'Stunned') {
      grantsAdvantageToAttacker = true;
    }
    
    // Unconscious - attacks have advantage, auto-crit if within 5 feet
    if (active.condition === 'Unconscious') {
      grantsAdvantageToAttacker = true;
      if (isMelee && isAdjacent) {
        autoCrit = true;
      }
    }
  }
  
  return { grantsAdvantageToAttacker, grantsDisadvantageToAttacker, autoHit, autoCrit };
}

/**
 * Get the appropriate ability modifier for an attack
 */
function getAttackAbility(
  attacker: CharacterSheet | Monster,
  attackerType: 'character' | 'monster',
  attackType: AttackType
): AbilityName {
  if (attackType === 'melee_spell' || attackType === 'ranged_spell') {
    // Spell attacks typically use spellcasting ability
    if (attackerType === 'character') {
      const char = attacker as CharacterSheet;
      // Determine spellcasting ability by class
      const classSpellAbility: Record<string, AbilityName> = {
        wizard: 'intelligence',
        artificer: 'intelligence',
        cleric: 'wisdom',
        druid: 'wisdom',
        ranger: 'wisdom',
        monk: 'wisdom',
        bard: 'charisma',
        paladin: 'charisma',
        sorcerer: 'charisma',
        warlock: 'charisma',
      };
      return classSpellAbility[char.class.toLowerCase()] || 'intelligence';
    }
    // For monsters, default to highest mental stat
    return 'intelligence';
  }
  
  if (attackType === 'melee_weapon') {
    return 'strength';
  }
  
  // Ranged weapons use Dexterity
  return 'dexterity';
}

/**
 * Calculate attack bonus
 */
function calculateAttackBonus(
  attacker: CharacterSheet | Monster,
  attackerType: 'character' | 'monster',
  attackType: AttackType,
  weaponBonus: number = 0
): number {
  if (attackerType === 'monster') {
    const monster = attacker as Monster;
    // Monsters have their attack bonus pre-calculated
    // Use proficiency + best relevant ability modifier
    const str = calculateModifier(monster.abilities.str);
    const dex = calculateModifier(monster.abilities.dex);
    const profBonus = Math.floor((monster.challengeRating || 1) / 4) + 2;
    
    if (attackType === 'melee_weapon') {
      return profBonus + str + weaponBonus;
    } else if (attackType === 'ranged_weapon') {
      return profBonus + dex + weaponBonus;
    }
    // Spell attacks
    const int = calculateModifier(monster.abilities.int);
    const wis = calculateModifier(monster.abilities.wis);
    const cha = calculateModifier(monster.abilities.cha);
    return profBonus + Math.max(int, wis, cha) + weaponBonus;
  }
  
  const char = attacker as CharacterSheet;
  const ability = getAttackAbility(char, 'character', attackType);
  const abilityMod = calculateModifier(char.abilities[ability.toLowerCase() as keyof AbilityScores]);
  const profBonus = getProficiencyBonus(char.level);
  
  return abilityMod + profBonus + weaponBonus;
}

/**
 * Get target AC
 */
function getTargetAC(
  target: CharacterSheet | Monster,
  targetType: 'character' | 'monster'
): number {
  if (targetType === 'monster') {
    return (target as Monster).ac;
  }
  return (target as CharacterSheet).armorClass;
}

/**
 * Get target damage modifiers
 */
function getTargetDamageModifiers(
  target: CharacterSheet | Monster,
  targetType: 'character' | 'monster'
): DamageModifiers {
  if (targetType === 'monster') {
    const monster = target as Monster;
    return {
      resistances: monster.resistances || [],
      immunities: monster.immunities || [],
      vulnerabilities: monster.vulnerabilities || [],
    };
  }
  // Characters rarely have innate resistances (usually from magic items/spells)
  return {
    resistances: [],
    immunities: [],
    vulnerabilities: [],
  };
}

/**
 * Make an attack roll
 */
export function makeAttackRoll(params: AttackParams): AttackResult {
  const {
    attacker,
    attackerType,
    target,
    targetType,
    attackType,
    weaponBonus = 0,
    damageNotation,
    damageType,
    additionalDamage = [],
    attackerConditions = [],
    targetConditions = [],
    coverBonus = 0,
    rangeCategory = 'normal',
  } = params;
  
  // Determine advantage/disadvantage from conditions
  const attackerMods = getAttackerConditionModifiers(attackerConditions, attackType);
  const targetMods = getTargetConditionModifiers(targetConditions, attackType);
  
  // Long range gives disadvantage
  let hasDisadvantage = params.disadvantage || attackerMods.grantsDisadvantage || targetMods.grantsDisadvantageToAttacker;
  if (rangeCategory === 'long') {
    hasDisadvantage = true;
  }
  
  let hasAdvantage = params.advantage || attackerMods.grantsAdvantage || targetMods.grantsAdvantageToAttacker;
  
  // Resolve advantage/disadvantage
  if (hasAdvantage && hasDisadvantage) {
    hasAdvantage = false;
    hasDisadvantage = false;
  }
  
  // Roll attack
  const attackBonus = calculateAttackBonus(attacker, attackerType, attackType, weaponBonus);
  const targetAC = getTargetAC(target, targetType) + coverBonus;
  
  const attackDiceResult = executeDiceRoll({
    dice: [{ type: 'd20', count: 1, modifier: 0 }],
    advantage: hasAdvantage,
    disadvantage: hasDisadvantage,
    description: 'Attack roll',
  });
  
  const naturalRoll = attackDiceResult.individualRolls[0]?.[0] || 0;
  const attackRoll = attackDiceResult.total + attackBonus;
  
  // Determine hit/miss
  const criticalMiss = naturalRoll === 1;
  let critical = naturalRoll === 20 || targetMods.autoCrit;
  const hit = !criticalMiss && (critical || attackRoll >= targetAC);
  
  // If hit, calculate damage
  let totalDamage = 0;
  const damageBreakdown: AttackResult['damageBreakdown'] = [];
  const targetDamageMods = getTargetDamageModifiers(target, targetType);
  
  if (hit) {
    // Roll primary damage
    const primaryDice = parseDiceNotation(damageNotation);
    const primaryDamageResult = executeDiceRoll({
      dice: primaryDice.dice,
      criticalHit: critical,
      description: 'Damage roll',
    });
    
    const baseDamage = primaryDamageResult.total + primaryDice.modifier;
    const { finalDamage, modifier } = calculateFinalDamage(baseDamage, damageType, targetDamageMods);
    
    damageBreakdown.push({
      type: damageType,
      baseDamage,
      finalDamage,
      modifier,
    });
    totalDamage += finalDamage;
    
    // Roll additional damage (e.g., sneak attack, smite)
    for (const addDmg of additionalDamage) {
      const addDice = parseDiceNotation(addDmg.notation);
      const addResult = executeDiceRoll({
        dice: addDice.dice,
        criticalHit: critical,
        description: `Additional ${addDmg.type} damage`,
      });
      
      const addBase = addResult.total + addDice.modifier;
      const addFinal = calculateFinalDamage(addBase, addDmg.type, targetDamageMods);
      
      damageBreakdown.push({
        type: addDmg.type,
        baseDamage: addBase,
        finalDamage: addFinal.finalDamage,
        modifier: addFinal.modifier,
      });
      totalDamage += addFinal.finalDamage;
    }
  }
  
  // Generate description
  const attackerName = attackerType === 'character' 
    ? (attacker as CharacterSheet).name 
    : (attacker as Monster).name;
  const targetName = targetType === 'character'
    ? (target as CharacterSheet).name
    : (target as Monster).name;
  
  let description = `${attackerName} attacks ${targetName}: `;
  
  if (hasAdvantage) description += '(advantage) ';
  if (hasDisadvantage) description += '(disadvantage) ';
  
  description += `rolled ${naturalRoll}`;
  if (attackBonus !== 0) {
    description += ` ${attackBonus >= 0 ? '+' : ''}${attackBonus}`;
  }
  description += ` = ${attackRoll} vs AC ${targetAC}`;
  
  if (criticalMiss) {
    description += ' - Critical Miss!';
  } else if (critical && hit) {
    description += ` - Critical Hit! ${totalDamage} damage`;
  } else if (hit) {
    description += ` - Hit! ${totalDamage} ${damageType} damage`;
  } else {
    description += ' - Miss!';
  }
  
  return {
    hit,
    critical: critical && hit,
    criticalMiss,
    attackRoll,
    naturalRoll,
    attackBonus,
    targetAC,
    damage: damageBreakdown[0]?.baseDamage || 0,
    damageType,
    totalDamage,
    damageBreakdown,
    description,
  };
}

/**
 * Calculate cover AC bonus
 */
export function getCoverBonus(coverType: 'none' | 'half' | 'three_quarters' | 'full'): number {
  switch (coverType) {
    case 'half': return 2;
    case 'three_quarters': return 5;
    case 'full': return Infinity; // Can't be targeted
    default: return 0;
  }
}

/**
 * Determine if ranged attack is at disadvantage due to being in melee
 */
export function isInMeleeRange(attacker: { x: number; y: number }, enemies: Array<{ x: number; y: number }>): boolean {
  // 5 feet = 1 grid square typically
  return enemies.some(enemy => {
    const dx = Math.abs(attacker.x - enemy.x);
    const dy = Math.abs(attacker.y - enemy.y);
    return dx <= 1 && dy <= 1;
  });
}
