/**
 * Saving Throw Rules
 * D&D 5e saving throw resolution
 */

import {
  type AbilityName,
  type CharacterSheet,
  type Monster,
  type ActiveCondition,
  calculateModifier,
  getProficiencyBonus,
  executeDiceRoll,
  normalizeCondition,
  getConditionName,
  getAbilityMod,
} from '../types';

export interface SavingThrowParams {
  creature: CharacterSheet | Monster;
  creatureType: 'character' | 'monster';
  ability: AbilityName;
  dc: number;
  advantage?: boolean;
  disadvantage?: boolean;
  bonusModifiers?: number;
  activeConditions?: ActiveCondition[];
  magicResistance?: boolean;
}

export interface SavingThrowResult {
  success: boolean;
  total: number;
  naturalRoll: number;
  modifier: number;
  dc: number;
  hadAdvantage: boolean;
  hadDisadvantage: boolean;
  proficient: boolean;
  description: string;
}

export interface SpellSaveParams {
  caster: CharacterSheet | Monster;
  casterType: 'character' | 'monster';
  target: CharacterSheet | Monster;
  targetType: 'character' | 'monster';
  saveAbility: AbilityName;
  spellLevel?: number;
  halfDamageOnSave?: boolean;
  targetConditions?: ActiveCondition[];
}

/**
 * Get condition modifiers for saving throws
 */
function getConditionModifiers(
  conditions: ActiveCondition[],
  ability: AbilityName
): { grantsAdvantage: boolean; grantsDisadvantage: boolean; autoFail: boolean } {
  let grantsAdvantage = false;
  let grantsDisadvantage = false;
  let autoFail = false;
  
  for (const active of conditions) {
    const condName = normalizeCondition(getConditionName(active));
    
    // Restrained - disadvantage on Dexterity saves
    if (condName === 'restrained' && ability === 'dexterity') {
      grantsDisadvantage = true;
    }
    
    // Paralyzed - auto-fail Strength and Dexterity saves
    if (condName === 'paralyzed' && (ability === 'strength' || ability === 'dexterity')) {
      autoFail = true;
    }
    
    // Stunned - auto-fail Strength and Dexterity saves
    if (condName === 'stunned' && (ability === 'strength' || ability === 'dexterity')) {
      autoFail = true;
    }
    
    // Petrified - auto-fail Strength and Dexterity saves
    if (condName === 'petrified' && (ability === 'strength' || ability === 'dexterity')) {
      autoFail = true;
    }
    
    // Unconscious - auto-fail Strength and Dexterity saves
    if (condName === 'unconscious' && (ability === 'strength' || ability === 'dexterity')) {
      autoFail = true;
    }
    
    // Exhaustion level 3+ - disadvantage on saving throws
    if (condName === 'exhaustion' && (active.exhaustionLevel ?? active.level ?? 1) >= 3) {
      grantsDisadvantage = true;
    }
  }
  
  return { grantsAdvantage, grantsDisadvantage, autoFail };
}

/**
 * Check if creature has proficiency in saving throw
 */
function hasSaveProficiency(
  creature: CharacterSheet | Monster,
  creatureType: 'character' | 'monster',
  ability: AbilityName
): boolean {
  if (creatureType === 'character') {
    const char = creature as CharacterSheet;
    return char.proficiencies?.savingThrows?.includes(ability) ?? false;
  }
  
  // Monsters have save proficiencies in their stat block
  const monster = creature as Monster;
  if (monster.savingThrows) {
    const abilityLower = ability.toLowerCase().slice(0, 3) as keyof Monster['savingThrows'];
    return (monster.savingThrows[abilityLower] ?? null) !== null;
  }
  return false;
}

/**
 * Get save modifier for a creature
 */
function getSaveModifier(
  creature: CharacterSheet | Monster,
  creatureType: 'character' | 'monster',
  ability: AbilityName
): number {
  if (creatureType === 'monster') {
    const monster = creature as Monster;
    // Check for explicit save bonus
    if (monster.savingThrows) {
      const abilityShort = ability.toLowerCase().slice(0, 3) as keyof Monster['savingThrows'];
      const saveBonus = monster.savingThrows[abilityShort];
      if (saveBonus !== undefined) {
        return saveBonus;
      }
    }
    // Fall back to just ability modifier
    const abilityShortKey = ability.toLowerCase().slice(0, 3) as keyof typeof monster.abilities;
    return calculateModifier(monster.abilities[abilityShortKey]);
  }
  
  const char = creature as CharacterSheet;
  const abilityMod = getAbilityMod(char.abilities[ability]);
  const profBonus = getProficiencyBonus(char.level);
  const proficient = char.proficiencies?.savingThrows?.includes(ability) ?? false;
  
  return abilityMod + (proficient ? profBonus : 0);
}

/**
 * Make a saving throw
 */
export function makeSavingThrow(params: SavingThrowParams): SavingThrowResult {
  const {
    creature,
    creatureType,
    ability,
    dc,
    bonusModifiers = 0,
    activeConditions = [],
    magicResistance = false,
  } = params;
  
  // Check condition modifiers
  const conditionMods = getConditionModifiers(activeConditions, ability);
  
  // Auto-fail from conditions
  if (conditionMods.autoFail) {
    const creatureName = creatureType === 'character' 
      ? (creature as CharacterSheet).name 
      : (creature as Monster).name;
    
    return {
      success: false,
      total: 0,
      naturalRoll: 0,
      modifier: 0,
      dc,
      hadAdvantage: false,
      hadDisadvantage: false,
      proficient: false,
      description: `${creatureName} automatically fails the ${ability} saving throw (incapacitated).`,
    };
  }
  
  // Determine advantage/disadvantage
  let hasAdvantage = params.advantage || conditionMods.grantsAdvantage || magicResistance;
  let hasDisadvantage = params.disadvantage || conditionMods.grantsDisadvantage;
  
  // Resolve advantage/disadvantage
  if (hasAdvantage && hasDisadvantage) {
    hasAdvantage = false;
    hasDisadvantage = false;
  }
  
  // Calculate modifier
  const modifier = getSaveModifier(creature, creatureType, ability) + bonusModifiers;
  const proficient = hasSaveProficiency(creature, creatureType, ability);
  
  // Roll
  const rollResult = executeDiceRoll({
    count: 1,
    die: 'd20',
    modifier: 0,
    advantage: hasAdvantage,
    disadvantage: hasDisadvantage,
  });
  
  const naturalRoll = rollResult.naturalRoll;
  const total = rollResult.total + modifier;
  const success = total >= dc;
  
  // Generate description
  const creatureName = creatureType === 'character' 
    ? (creature as CharacterSheet).name 
    : (creature as Monster).name;
  
  let description = `${creatureName} makes a ${ability} saving throw`;
  if (proficient) description += ' (proficient)';
  if (hasAdvantage) description += ' with advantage';
  if (hasDisadvantage) description += ' with disadvantage';
  
  description += `: rolled ${naturalRoll}`;
  if (modifier !== 0) {
    description += ` ${modifier >= 0 ? '+' : ''}${modifier}`;
  }
  description += ` = ${total} vs DC ${dc}`;
  description += success ? ' - Success!' : ' - Failure!';
  
  return {
    success,
    total,
    naturalRoll,
    modifier,
    dc,
    hadAdvantage: hasAdvantage,
    hadDisadvantage: hasDisadvantage,
    proficient,
    description,
  };
}

/**
 * Calculate spell save DC for a caster
 */
export function calculateSpellSaveDC(
  caster: CharacterSheet | Monster,
  casterType: 'character' | 'monster'
): number {
  if (casterType === 'monster') {
    const monster = caster as Monster;
    // Monsters typically have explicit DCs or use: 8 + prof + highest mental
    const profBonus = Math.floor((monster.challengeRating || 1) / 4) + 2;
    const int = calculateModifier(monster.abilities.int);
    const wis = calculateModifier(monster.abilities.wis);
    const cha = calculateModifier(monster.abilities.cha);
    return 8 + profBonus + Math.max(int, wis, cha);
  }
  
  const char = caster as CharacterSheet;
  const profBonus = getProficiencyBonus(char.level);
  
  // Get spellcasting ability based on class
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
  
  const spellAbility = (classSpellAbility[char.class.toLowerCase()] || 'intelligence') as AbilityName;
  const abilityMod = getAbilityMod(char.abilities[spellAbility]);
  
  return 8 + profBonus + abilityMod;
}

/**
 * Make a spell saving throw
 */
export function makeSpellSave(params: SpellSaveParams): SavingThrowResult {
  const {
    caster,
    casterType,
    target,
    targetType,
    saveAbility,
    targetConditions = [],
  } = params;
  
  const dc = calculateSpellSaveDC(caster, casterType);
  
  // Check for magic resistance
  let magicResistance = false;
  if (targetType === 'monster') {
    const monster = target as Monster;
    // Many monsters have magic resistance - check special abilities
    magicResistance = monster.specialAbilities?.some(
      a => a.name.toLowerCase().includes('magic resistance')
    ) || false;
  }
  
  return makeSavingThrow({
    creature: target,
    creatureType: targetType,
    ability: saveAbility,
    dc,
    activeConditions: targetConditions,
    magicResistance,
  });
}

/**
 * Common save DCs by level/difficulty
 */
export const SAVE_DCS_BY_CHALLENGE = {
  0: 10,
  0.125: 10,
  0.25: 10,
  0.5: 11,
  1: 11,
  2: 12,
  3: 12,
  4: 13,
  5: 13,
  6: 14,
  7: 14,
  8: 15,
  9: 15,
  10: 16,
  11: 16,
  12: 17,
  13: 17,
  14: 18,
  15: 18,
  16: 18,
  17: 19,
  18: 19,
  19: 19,
  20: 20,
} as const;

/**
 * Death saving throw
 */
export function makeDeathSave(): {
  success: boolean;
  stabilized: boolean;
  died: boolean;
  naturalRoll: number;
  description: string;
} {
  const rollResult = executeDiceRoll({
    count: 1,
    die: 'd20',
    modifier: 0,
    advantage: false,
    disadvantage: false,
  });
  
  const naturalRoll = rollResult.total;
  
  // Natural 20 = regain 1 HP (stabilized + conscious)
  if (naturalRoll === 20) {
    return {
      success: true,
      stabilized: true,
      died: false,
      naturalRoll,
      description: `Rolled a natural 20! Regains 1 HP and is conscious.`,
    };
  }
  
  // Natural 1 = 2 failures
  if (naturalRoll === 1) {
    return {
      success: false,
      stabilized: false,
      died: false, // Might die if this is their 2nd or 3rd failure total
      naturalRoll,
      description: `Rolled a natural 1! Two death save failures.`,
    };
  }
  
  // 10+ = success
  const success = naturalRoll >= 10;
  
  return {
    success,
    stabilized: false, // Caller tracks total successes
    died: false, // Caller tracks total failures
    naturalRoll,
    description: `Death save: rolled ${naturalRoll} - ${success ? 'Success!' : 'Failure!'}`,
  };
}

/**
 * Concentration check (Constitution save vs damage taken / 2, minimum DC 10)
 */
export function makeConcentrationCheck(
  caster: CharacterSheet,
  damageTaken: number,
  activeConditions: ActiveCondition[] = []
): SavingThrowResult {
  const dc = Math.max(10, Math.floor(damageTaken / 2));
  
  return makeSavingThrow({
    creature: caster,
    creatureType: 'character',
    ability: 'constitution',
    dc,
    activeConditions,
  });
}
