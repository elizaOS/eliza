/**
 * Ability Check Rules
 * D&D 5e ability check and skill check resolution
 */

import {
  type AbilityName,
  type SkillName,
  type CharacterSheet,
  type ActiveCondition,
  getProficiencyBonus,
  calculateSkillModifier,
  SKILLS,
  executeDiceRoll,
  normalizeCondition,
  getConditionName,
  getAbilityMod,
} from '../types';

export interface AbilityCheckParams {
  character: CharacterSheet;
  ability: AbilityName;
  dc: number;
  advantage?: boolean;
  disadvantage?: boolean;
  bonusModifiers?: number;
  activeConditions?: ActiveCondition[];
}

export interface AbilityCheckResult {
  success: boolean;
  total: number;
  roll: number;
  modifier: number;
  dc: number;
  hadAdvantage: boolean;
  hadDisadvantage: boolean;
  naturalRoll: number;
  criticalSuccess: boolean;
  criticalFail: boolean;
  description: string;
}

export interface SkillCheckParams extends Omit<AbilityCheckParams, 'ability'> {
  skill: SkillName;
}

export interface SkillCheckResult extends AbilityCheckResult {
  skill: SkillName;
  proficient: boolean;
  expertise: boolean;
}

export interface ContestedCheckParams {
  attacker: CharacterSheet;
  defender: CharacterSheet;
  attackerAbility: AbilityName;
  defenderAbility: AbilityName;
  attackerAdvantage?: boolean;
  attackerDisadvantage?: boolean;
  defenderAdvantage?: boolean;
  defenderDisadvantage?: boolean;
}

export interface ContestedCheckResult {
  attackerWins: boolean;
  attackerTotal: number;
  defenderTotal: number;
  attackerRoll: number;
  defenderRoll: number;
  description: string;
}

/**
 * Determine if conditions grant advantage or disadvantage
 */
function getConditionModifiers(conditions: ActiveCondition[]): {
  grantsAdvantage: boolean;
  grantsDisadvantage: boolean;
} {
  let grantsAdvantage = false;
  let grantsDisadvantage = false;
  
  for (const active of conditions) {
    const condName = normalizeCondition(getConditionName(active));
    
    // Poisoned - disadvantage on ability checks
    if (condName === 'poisoned') {
      grantsDisadvantage = true;
    }
    
    // Frightened - disadvantage on ability checks (when source visible, simplified)
    if (condName === 'frightened') {
      grantsDisadvantage = true;
    }
    
    // Exhaustion level 1+ gives disadvantage on ability checks
    if (condName === 'exhaustion' && (active.exhaustionLevel ?? active.level ?? 1) >= 1) {
      grantsDisadvantage = true;
    }
  }
  
  return { grantsAdvantage, grantsDisadvantage };
}

/**
 * Resolve advantage/disadvantage (they cancel out)
 */
function resolveAdvantageDisadvantage(
  advantage: boolean,
  disadvantage: boolean
): { hasAdvantage: boolean; hasDisadvantage: boolean } {
  // Multiple sources don't stack - if you have both, they cancel
  if (advantage && disadvantage) {
    return { hasAdvantage: false, hasDisadvantage: false };
  }
  return { hasAdvantage: advantage, hasDisadvantage: disadvantage };
}

/**
 * Make an ability check
 */
export function makeAbilityCheck(params: AbilityCheckParams): AbilityCheckResult {
  const { character, ability, dc, bonusModifiers = 0, activeConditions = [] } = params;
  
  // Get condition modifiers
  const conditionMods = getConditionModifiers(activeConditions);
  
  // Resolve advantage/disadvantage
  const { hasAdvantage, hasDisadvantage } = resolveAdvantageDisadvantage(
    params.advantage || conditionMods.grantsAdvantage,
    params.disadvantage || conditionMods.grantsDisadvantage
  );
  
  // Get ability modifier
  const modifier = getAbilityMod(character.abilities[ability]) + bonusModifiers;
  
  // Roll the d20
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
  
  // Natural 20s and 1s are only critical for attack rolls in RAW,
  // but many tables use them for ability checks too
  const criticalSuccess = naturalRoll === 20;
  const criticalFail = naturalRoll === 1;
  
  const description = formatAbilityCheckDescription({
    characterName: character.name,
    ability,
    roll: naturalRoll,
    modifier,
    total,
    dc,
    success,
    hasAdvantage,
    hasDisadvantage,
    criticalSuccess,
    criticalFail,
  });
  
  return {
    success,
    total,
    roll: naturalRoll,
    modifier,
    dc,
    hadAdvantage: hasAdvantage,
    hadDisadvantage: hasDisadvantage,
    naturalRoll,
    criticalSuccess,
    criticalFail,
    description,
  };
}

/**
 * Make a skill check
 */
export function makeSkillCheck(params: SkillCheckParams): SkillCheckResult {
  const { character, skill, dc, bonusModifiers = 0, activeConditions = [] } = params;
  
  const skillDef = SKILLS[skill];
  const ability = skillDef.ability;
  
  // Check proficiency and expertise
  const proficient = character.proficiencies?.skills?.includes(skill) ?? false;
  const expertise = character.expertise?.includes(skill) ?? false;
  
  // Calculate skill modifier
  const abilityMod = getAbilityMod(character.abilities[ability]);
  const proficiencyBonus = getProficiencyBonus(character.level);
  const skillMod = calculateSkillModifier(abilityMod, proficiencyBonus, { skill, proficient, expertise });
  
  // Get condition modifiers
  const conditionMods = getConditionModifiers(activeConditions);
  
  // Resolve advantage/disadvantage
  const { hasAdvantage, hasDisadvantage } = resolveAdvantageDisadvantage(
    params.advantage || conditionMods.grantsAdvantage,
    params.disadvantage || conditionMods.grantsDisadvantage
  );
  
  // Roll the d20
  const rollResult = executeDiceRoll({
    count: 1,
    die: 'd20',
    modifier: 0,
    advantage: hasAdvantage,
    disadvantage: hasDisadvantage,
  });
  
  const naturalRoll = rollResult.naturalRoll;
  const totalModifier = skillMod + bonusModifiers;
  const total = rollResult.total + totalModifier;
  const success = total >= dc;
  
  const criticalSuccess = naturalRoll === 20;
  const criticalFail = naturalRoll === 1;
  
  const description = formatSkillCheckDescription({
    characterName: character.name,
    skill,
    ability,
    roll: naturalRoll,
    modifier: totalModifier,
    total,
    dc,
    success,
    proficient,
    expertise,
    hasAdvantage,
    hasDisadvantage,
    criticalSuccess,
    criticalFail,
  });
  
  return {
    success,
    total,
    roll: naturalRoll,
    modifier: totalModifier,
    dc,
    hadAdvantage: hasAdvantage,
    hadDisadvantage: hasDisadvantage,
    naturalRoll,
    criticalSuccess,
    criticalFail,
    skill,
    proficient,
    expertise,
    description,
  };
}

/**
 * Make a contested ability check
 */
export function makeContestedCheck(params: ContestedCheckParams): ContestedCheckResult {
  const attackerResult = makeAbilityCheck({
    character: params.attacker,
    ability: params.attackerAbility,
    dc: 0, // Not used for contested
    advantage: params.attackerAdvantage,
    disadvantage: params.attackerDisadvantage,
  });
  
  const defenderResult = makeAbilityCheck({
    character: params.defender,
    ability: params.defenderAbility,
    dc: 0,
    advantage: params.defenderAdvantage,
    disadvantage: params.defenderDisadvantage,
  });
  
  // Attacker wins ties
  const attackerWins = attackerResult.total >= defenderResult.total;
  
  const description = `${params.attacker.name} (${attackerResult.total}) vs ${params.defender.name} (${defenderResult.total}): ${attackerWins ? params.attacker.name : params.defender.name} wins!`;
  
  return {
    attackerWins,
    attackerTotal: attackerResult.total,
    defenderTotal: defenderResult.total,
    attackerRoll: attackerResult.naturalRoll,
    defenderRoll: defenderResult.naturalRoll,
    description,
  };
}

/**
 * Calculate passive check score
 */
export function getPassiveScore(
  character: CharacterSheet,
  skill: SkillName,
  activeConditions: ActiveCondition[] = []
): number {
  const skillDef = SKILLS[skill];
  const ability = skillDef.ability;
  
  const proficient = character.proficiencies?.skills?.includes(skill) ?? false;
  const expertise = character.expertise?.includes(skill) ?? false;
  
  const abilityMod = getAbilityMod(character.abilities[ability]);
  const proficiencyBonus = getProficiencyBonus(character.level);
  const skillMod = calculateSkillModifier(abilityMod, proficiencyBonus, { skill, proficient, expertise });
  
  // Base passive is 10 + modifier
  let passive = 10 + skillMod;
  
  // Disadvantage on passive checks subtracts 5
  const conditionMods = getConditionModifiers(activeConditions);
  if (conditionMods.grantsDisadvantage) {
    passive -= 5;
  } else if (conditionMods.grantsAdvantage) {
    passive += 5;
  }
  
  return passive;
}

// ============================================================================
// FORMATTING HELPERS
// ============================================================================

interface AbilityCheckDescriptionParams {
  characterName: string;
  ability: AbilityName;
  roll: number;
  modifier: number;
  total: number;
  dc: number;
  success: boolean;
  hasAdvantage: boolean;
  hasDisadvantage: boolean;
  criticalSuccess: boolean;
  criticalFail: boolean;
}

function formatAbilityCheckDescription(params: AbilityCheckDescriptionParams): string {
  const {
    characterName,
    ability,
    roll,
    modifier,
    total,
    dc,
    success,
    hasAdvantage,
    hasDisadvantage,
    criticalSuccess,
    criticalFail,
  } = params;
  
  let desc = `${characterName} makes a ${ability} check`;
  
  if (hasAdvantage) desc += ' with advantage';
  if (hasDisadvantage) desc += ' with disadvantage';
  
  desc += `: rolled ${roll}`;
  
  if (modifier !== 0) {
    desc += ` ${modifier >= 0 ? '+' : ''}${modifier}`;
  }
  
  desc += ` = ${total} vs DC ${dc}`;
  
  if (criticalSuccess) {
    desc += ' (Natural 20!)';
  } else if (criticalFail) {
    desc += ' (Natural 1!)';
  }
  
  desc += success ? ' - Success!' : ' - Failure.';
  
  return desc;
}

interface SkillCheckDescriptionParams extends Omit<AbilityCheckDescriptionParams, 'ability'> {
  skill: SkillName;
  ability: AbilityName;
  proficient: boolean;
  expertise: boolean;
}

function formatSkillCheckDescription(params: SkillCheckDescriptionParams): string {
  const {
    characterName,
    skill,
    roll,
    modifier,
    total,
    dc,
    success,
    proficient,
    expertise,
    hasAdvantage,
    hasDisadvantage,
  } = params;
  
  let desc = `${characterName} makes a ${skill} check`;
  
  if (expertise) {
    desc += ' (expertise)';
  } else if (proficient) {
    desc += ' (proficient)';
  }
  
  if (hasAdvantage) desc += ' with advantage';
  if (hasDisadvantage) desc += ' with disadvantage';
  
  desc += `: rolled ${roll}`;
  
  if (modifier !== 0) {
    desc += ` ${modifier >= 0 ? '+' : ''}${modifier}`;
  }
  
  desc += ` = ${total} vs DC ${dc}`;
  desc += success ? ' - Success!' : ' - Failure.';
  
  return desc;
}

/**
 * Common DC table for reference
 */
export const DIFFICULTY_CLASS = {
  veryEasy: 5,
  easy: 10,
  medium: 15,
  hard: 20,
  veryHard: 25,
  nearlyImpossible: 30,
} as const;

export type DifficultyLevel = keyof typeof DIFFICULTY_CLASS;

/**
 * Get DC by difficulty name
 */
export function getDCByDifficulty(difficulty: DifficultyLevel): number {
  return DIFFICULTY_CLASS[difficulty];
}
