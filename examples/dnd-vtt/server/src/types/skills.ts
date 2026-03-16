/**
 * D&D 5e Skills System
 * All 18 skills mapped to their governing abilities
 */

import type { AbilityName } from './abilities';

export type SkillName =
  | 'acrobatics'
  | 'animalHandling'
  | 'arcana'
  | 'athletics'
  | 'deception'
  | 'history'
  | 'insight'
  | 'intimidation'
  | 'investigation'
  | 'medicine'
  | 'nature'
  | 'perception'
  | 'performance'
  | 'persuasion'
  | 'religion'
  | 'sleightOfHand'
  | 'stealth'
  | 'survival';

export const SKILL_NAMES: SkillName[] = [
  'acrobatics',
  'animalHandling',
  'arcana',
  'athletics',
  'deception',
  'history',
  'insight',
  'intimidation',
  'investigation',
  'medicine',
  'nature',
  'perception',
  'performance',
  'persuasion',
  'religion',
  'sleightOfHand',
  'stealth',
  'survival',
];

export interface SkillDefinition {
  name: SkillName;
  displayName: string;
  ability: AbilityName;
  description: string;
}

export const SKILLS: Record<SkillName, SkillDefinition> = {
  acrobatics: {
    name: 'acrobatics',
    displayName: 'Acrobatics',
    ability: 'dexterity',
    description: 'Staying on your feet in tricky situations, such as trying to run across ice, balance on a tightrope, or stay upright on a rocking ship\'s deck.',
  },
  animalHandling: {
    name: 'animalHandling',
    displayName: 'Animal Handling',
    ability: 'wisdom',
    description: 'Calming down a domesticated animal, keeping a mount from getting spooked, or intuiting an animal\'s intentions.',
  },
  arcana: {
    name: 'arcana',
    displayName: 'Arcana',
    ability: 'intelligence',
    description: 'Recalling lore about spells, magic items, eldritch symbols, magical traditions, planes of existence, and inhabitants of those planes.',
  },
  athletics: {
    name: 'athletics',
    displayName: 'Athletics',
    ability: 'strength',
    description: 'Difficult situations encountered while climbing, jumping, or swimming.',
  },
  deception: {
    name: 'deception',
    displayName: 'Deception',
    ability: 'charisma',
    description: 'Convincingly hiding the truth, either verbally or through actions, encompasses everything from misleading others through ambiguity to telling outright lies.',
  },
  history: {
    name: 'history',
    displayName: 'History',
    ability: 'intelligence',
    description: 'Recalling lore about historical events, legendary people, ancient kingdoms, past disputes, recent wars, and lost civilizations.',
  },
  insight: {
    name: 'insight',
    displayName: 'Insight',
    ability: 'wisdom',
    description: 'Determining the true intentions of a creature, such as when searching out a lie or predicting someone\'s next move.',
  },
  intimidation: {
    name: 'intimidation',
    displayName: 'Intimidation',
    ability: 'charisma',
    description: 'Influencing someone through overt threats, hostile actions, and physical violence.',
  },
  investigation: {
    name: 'investigation',
    displayName: 'Investigation',
    ability: 'intelligence',
    description: 'Looking around for clues and making deductions based on those clues.',
  },
  medicine: {
    name: 'medicine',
    displayName: 'Medicine',
    ability: 'wisdom',
    description: 'Trying to stabilize a dying companion or diagnose an illness.',
  },
  nature: {
    name: 'nature',
    displayName: 'Nature',
    ability: 'intelligence',
    description: 'Recalling lore about terrain, plants and animals, the weather, and natural cycles.',
  },
  perception: {
    name: 'perception',
    displayName: 'Perception',
    ability: 'wisdom',
    description: 'Spotting, hearing, or otherwise detecting the presence of something. It measures general awareness of surroundings and keenness of senses.',
  },
  performance: {
    name: 'performance',
    displayName: 'Performance',
    ability: 'charisma',
    description: 'Determining how well you can delight an audience with music, dance, acting, storytelling, or some other form of entertainment.',
  },
  persuasion: {
    name: 'persuasion',
    displayName: 'Persuasion',
    ability: 'charisma',
    description: 'Influencing someone or a group of people with tact, social graces, or good nature.',
  },
  religion: {
    name: 'religion',
    displayName: 'Religion',
    ability: 'intelligence',
    description: 'Recalling lore about deities, rites and prayers, religious hierarchies, holy symbols, and practices of secret cults.',
  },
  sleightOfHand: {
    name: 'sleightOfHand',
    displayName: 'Sleight of Hand',
    ability: 'dexterity',
    description: 'An act of legerdemain or manual trickery, such as planting something on someone else or concealing an object on your person.',
  },
  stealth: {
    name: 'stealth',
    displayName: 'Stealth',
    ability: 'dexterity',
    description: 'Concealing yourself from enemies, slinking past guards, slipping away without being noticed, or sneaking up on someone without being seen or heard.',
  },
  survival: {
    name: 'survival',
    displayName: 'Survival',
    ability: 'wisdom',
    description: 'Following tracks, hunting wild game, guiding your group through frozen wastelands, identifying signs that owlbears live nearby, predicting the weather, or avoiding quicksand.',
  },
};

export interface SkillProficiency {
  skill: SkillName;
  proficient: boolean;
  expertise: boolean; // Double proficiency bonus
}

/**
 * Calculate skill modifier
 */
export function calculateSkillModifier(
  abilityModifier: number,
  proficiencyBonus: number,
  proficiency: SkillProficiency
): number {
  if (proficiency.expertise) {
    return abilityModifier + (proficiencyBonus * 2);
  }
  if (proficiency.proficient) {
    return abilityModifier + proficiencyBonus;
  }
  return abilityModifier;
}

/**
 * Calculate passive skill score (used for Perception, Insight, Investigation)
 */
export function calculatePassiveScore(skillModifier: number): number {
  return 10 + skillModifier;
}
