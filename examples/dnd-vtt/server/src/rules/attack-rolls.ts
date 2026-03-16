/**
 * Attack Roll Rules
 * D&D 5e attack resolution including melee, ranged, and spell attacks
 */

import {
  type AbilityName,
  type CharacterSheet,
  type Monster,
  type ActiveCondition,
  type DamageType,
  type DamageModifier,
  type DamageInstance,
  calculateModifier,
  getProficiencyBonus,
  executeDiceRoll,
  parseDiceNotation,
  rollDamage,
  calculateFinalDamage,
  getAC,
  getAbilityMod,
  normalizeCondition,
  getConditionName,
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
    const condName = normalizeCondition(getConditionName(active));
    
    // Blinded - disadvantage on attack rolls
    if (condName === 'blinded') {
      grantsDisadvantage = true;
    }
    
    // Frightened - disadvantage if source is in sight (simplified to always)
    if (condName === 'frightened') {
      grantsDisadvantage = true;
    }
    
    // Poisoned - disadvantage on attack rolls
    if (condName === 'poisoned') {
      grantsDisadvantage = true;
    }
    
    // Prone - disadvantage on attack rolls
    if (condName === 'prone') {
      grantsDisadvantage = true;
    }
    
    // Restrained - disadvantage on attack rolls
    if (condName === 'restrained') {
      grantsDisadvantage = true;
    }
    
    // Exhaustion level 3+ - disadvantage on attack rolls
    if (condName === 'exhaustion' && (active.exhaustionLevel ?? active.level ?? 1) >= 3) {
      grantsDisadvantage = true;
    }
    
    // Invisible - advantage on attack rolls
    if (condName === 'invisible') {
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
    const condName = normalizeCondition(getConditionName(active));
    
    // Blinded - attacks against have advantage
    if (condName === 'blinded') {
      grantsAdvantageToAttacker = true;
    }
    
    // Invisible - attacks against have disadvantage
    if (condName === 'invisible') {
      grantsDisadvantageToAttacker = true;
    }
    
    // Paralyzed - attacks have advantage, auto-crit if within 5 feet
    if (condName === 'paralyzed') {
      grantsAdvantageToAttacker = true;
      if (isMelee && isAdjacent) {
        autoCrit = true;
      }
    }
    
    // Petrified - attacks have advantage
    if (condName === 'petrified') {
      grantsAdvantageToAttacker = true;
    }
    
    // Prone - melee has advantage, ranged has disadvantage
    if (condName === 'prone') {
      if (isMelee && isAdjacent) {
        grantsAdvantageToAttacker = true;
      } else if (isRanged) {
        grantsDisadvantageToAttacker = true;
      }
    }
    
    // Restrained - attacks have advantage
    if (condName === 'restrained') {
      grantsAdvantageToAttacker = true;
    }
    
    // Stunned - attacks have advantage
    if (condName === 'stunned') {
      grantsAdvantageToAttacker = true;
    }
    
    // Unconscious - attacks have advantage, auto-crit if within 5 feet
    if (condName === 'unconscious') {
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
  const abilityMod = getAbilityMod(char.abilities[ability]);
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
  return getAC(target as CharacterSheet);
}

/**
 * Get target damage modifiers
 */
function getTargetDamageModifiers(
  target: CharacterSheet | Monster,
  targetType: 'character' | 'monster'
): DamageModifier[] {
  const modifiers: DamageModifier[] = [];
  if (targetType === 'monster') {
    const monster = target as Monster;
    for (const r of (monster.resistances || [])) {
      modifiers.push({ type: 'resistance', damageType: r });
    }
    for (const i of (monster.immunities || [])) {
      modifiers.push({ type: 'immunity', damageType: i });
    }
    for (const v of (monster.vulnerabilities || [])) {
      modifiers.push({ type: 'vulnerability', damageType: v });
    }
  }
  // Characters rarely have innate resistances (usually from magic items/spells)
  return modifiers;
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
    count: 1,
    die: 'd20',
    modifier: 0,
    advantage: hasAdvantage,
    disadvantage: hasDisadvantage,
  });
  
  const naturalRoll = attackDiceResult.naturalRoll;
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
    const primaryDamageResult = rollDamage(primaryDice.count, primaryDice.die, primaryDice.modifier, critical);
    
    const baseDamage = primaryDamageResult.total;
    const primaryDamageInstance: DamageInstance = { amount: baseDamage, type: damageType, isMagical: false };
    const finalDmg = calculateFinalDamage(primaryDamageInstance, targetDamageMods);
    const primaryModLabel: 'normal' | 'resistant' | 'immune' | 'vulnerable' =
      finalDmg === 0 && baseDamage > 0 ? 'immune' : finalDmg < baseDamage ? 'resistant' : finalDmg > baseDamage ? 'vulnerable' : 'normal';
    
    damageBreakdown.push({
      type: damageType,
      baseDamage,
      finalDamage: finalDmg,
      modifier: primaryModLabel,
    });
    totalDamage += finalDmg;
    
    // Roll additional damage (e.g., sneak attack, smite)
    for (const addDmg of additionalDamage) {
      const addDice = parseDiceNotation(addDmg.notation);
      const addDamageResult = rollDamage(addDice.count, addDice.die, addDice.modifier, critical);
      
      const addBase = addDamageResult.total;
      const addInstance: DamageInstance = { amount: addBase, type: addDmg.type, isMagical: false };
      const addFinal = calculateFinalDamage(addInstance, targetDamageMods);
      const addModLabel: 'normal' | 'resistant' | 'immune' | 'vulnerable' =
        addFinal === 0 && addBase > 0 ? 'immune' : addFinal < addBase ? 'resistant' : addFinal > addBase ? 'vulnerable' : 'normal';
      
      damageBreakdown.push({
        type: addDmg.type,
        baseDamage: addBase,
        finalDamage: addFinal,
        modifier: addModLabel,
      });
      totalDamage += addFinal;
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
