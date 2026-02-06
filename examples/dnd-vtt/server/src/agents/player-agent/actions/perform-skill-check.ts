/**
 * Perform Skill Check Action
 * Handles skill checks requested by the DM
 */

import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from '@elizaos/core';
import type { CharacterSheet, SkillName, AbilityName } from '../../../types';
import { rollD20, rollWithAdvantage, rollWithDisadvantage } from '../../../dice';
import { makeSkillCheck } from '../../../rules';

export interface SkillCheckParams {
  skill?: SkillName;
  ability?: AbilityName;
  dc?: number;
  advantage?: boolean;
  disadvantage?: boolean;
  reason?: string;
}

export const performSkillCheckAction: Action = {
  name: 'PERFORM_SKILL_CHECK',
  description: 'Roll a skill or ability check when requested',
  
  similes: [
    'make a check',
    'roll for',
    'check your',
    'try to',
  ],
  
  examples: [
    [
      {
        user: '{{user1}}',
        content: {
          text: 'Make a Perception check.',
          action: 'PERFORM_SKILL_CHECK',
        },
      },
      {
        user: '{{agentName}}',
        content: {
          text: 'I scan the area carefully, looking for anything out of place...\n\n🎲 **Perception Check:** 15 + 4 = **19**',
        },
      },
    ],
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const role = await runtime.getSetting('role');
    return role === 'player';
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    const params = options as SkillCheckParams;
    const characterSheet = await runtime.getSetting('characterSheet') as CharacterSheet | null;
    
    if (!characterSheet) {
      if (callback) {
        await callback({
          text: 'I cannot make that check right now.',
          type: 'error',
        });
      }
      return false;
    }
    
    // Determine the skill/ability being checked
    const skill = params.skill;
    const ability = params.ability || (skill ? getAbilityForSkill(skill) : 'dexterity');
    
    // Get the modifier
    let modifier = characterSheet.abilities[ability]?.modifier || 0;
    
    if (skill && characterSheet.skills?.[skill] !== undefined) {
      modifier = characterSheet.skills[skill];
    }
    
    // Check for expertise
    const hasExpertise = characterSheet.expertise?.includes(skill as SkillName);
    if (hasExpertise) {
      modifier += characterSheet.proficiencyBonus; // Expertise doubles proficiency
    }
    
    // Roll the check
    let roll: number;
    let rollDescription: string;
    
    if (params.advantage && !params.disadvantage) {
      const result = rollWithAdvantage();
      roll = result.result;
      rollDescription = `(${result.rolls[0]}, ${result.rolls[1]}) with advantage`;
    } else if (params.disadvantage && !params.advantage) {
      const result = rollWithDisadvantage();
      roll = result.result;
      rollDescription = `(${result.rolls[0]}, ${result.rolls[1]}) with disadvantage`;
    } else {
      roll = rollD20();
      rollDescription = `${roll}`;
    }
    
    const total = roll + modifier;
    
    // Determine success if DC is known
    let successText = '';
    if (params.dc !== undefined) {
      const success = total >= params.dc;
      successText = success ? ' - **Success!**' : ' - **Failure.**';
    }
    
    // Generate flavor text based on the check
    const flavorText = generateCheckFlavor(skill || ability, characterSheet.name, roll === 20, roll === 1);
    
    // Format the skill/ability name
    const checkName = skill 
      ? skill.charAt(0).toUpperCase() + skill.slice(1)
      : ability.charAt(0).toUpperCase() + ability.slice(1);
    
    const response = `${flavorText}\n\n🎲 **${checkName} Check:** ${rollDescription} + ${modifier} = **${total}**${successText}`;
    
    if (callback) {
      await callback({
        text: response,
        type: 'skill_check',
        metadata: {
          characterId: characterSheet.id,
          characterName: characterSheet.name,
          skill,
          ability,
          roll,
          modifier,
          total,
          dc: params.dc,
          success: params.dc !== undefined ? total >= params.dc : undefined,
          advantage: params.advantage,
          disadvantage: params.disadvantage,
        },
      });
    }
    
    // Emit roll result
    await runtime.emit('roll_completed', {
      characterId: characterSheet.id,
      characterName: characterSheet.name,
      rollType: skill ? 'skill_check' : 'ability_check',
      skill,
      ability,
      roll,
      modifier,
      total,
      dc: params.dc,
      timestamp: new Date(),
    });
    
    return true;
  },
};

function getAbilityForSkill(skill: SkillName): AbilityName {
  const skillAbilities: Record<SkillName, AbilityName> = {
    acrobatics: 'dexterity',
    'animal handling': 'wisdom',
    arcana: 'intelligence',
    athletics: 'strength',
    deception: 'charisma',
    history: 'intelligence',
    insight: 'wisdom',
    intimidation: 'charisma',
    investigation: 'intelligence',
    medicine: 'wisdom',
    nature: 'intelligence',
    perception: 'wisdom',
    performance: 'charisma',
    persuasion: 'charisma',
    religion: 'intelligence',
    'sleight of hand': 'dexterity',
    stealth: 'dexterity',
    survival: 'wisdom',
  };
  
  return skillAbilities[skill] || 'dexterity';
}

function generateCheckFlavor(
  checkType: string,
  characterName: string,
  isNat20: boolean,
  isNat1: boolean
): string {
  if (isNat20) {
    return `With exceptional focus, ${characterName}'s instincts prove flawless...`;
  }
  
  if (isNat1) {
    return `Despite ${characterName}'s best efforts, something goes terribly wrong...`;
  }
  
  const flavors: Record<string, string[]> = {
    perception: [
      `${characterName} scans the surroundings carefully...`,
      `${characterName}'s eyes dart across the scene...`,
      `${characterName} listens intently and observes...`,
    ],
    stealth: [
      `${characterName} moves as quietly as possible...`,
      `${characterName} tries to blend into the shadows...`,
      `${characterName} carefully places each footstep...`,
    ],
    athletics: [
      `${characterName} draws upon their physical strength...`,
      `${characterName} pushes their body to the limit...`,
      `${characterName} tenses their muscles and acts...`,
    ],
    arcana: [
      `${characterName} recalls their arcane studies...`,
      `${characterName} examines the magical energies...`,
      `${characterName} draws upon mystical knowledge...`,
    ],
    investigation: [
      `${characterName} examines the details carefully...`,
      `${characterName} pieces together the clues...`,
      `${characterName} applies deductive reasoning...`,
    ],
    persuasion: [
      `${characterName} speaks with conviction...`,
      `${characterName} appeals to reason and emotion...`,
      `${characterName} chooses their words carefully...`,
    ],
    deception: [
      `${characterName} maintains a straight face...`,
      `${characterName} weaves a convincing tale...`,
      `${characterName} obscures the truth skillfully...`,
    ],
    insight: [
      `${characterName} studies the other's behavior...`,
      `${characterName} reads between the lines...`,
      `${characterName} trusts their intuition...`,
    ],
  };
  
  const options = flavors[checkType.toLowerCase()] || [`${characterName} focuses on the task...`];
  return options[Math.floor(Math.random() * options.length)];
}

export default performSkillCheckAction;
