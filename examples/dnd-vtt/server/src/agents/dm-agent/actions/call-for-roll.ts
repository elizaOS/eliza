/**
 * Call For Roll Action
 * Requests ability checks, saving throws, or skill checks from players
 */

import type { 
  Action, 
  IAgentRuntime, 
  Memory, 
  State, 
  HandlerCallback 
} from '@elizaos/core';
import type { AbilityName, SkillName } from '../../../types';
import { DIFFICULTY_CLASS, getDCByDifficulty } from '../../../rules';

export type RollType = 'ability_check' | 'saving_throw' | 'skill_check' | 'attack' | 'initiative' | 'death_save';

export interface CallForRollParams {
  rollType: RollType;
  ability?: AbilityName;
  skill?: SkillName;
  dc?: number;
  difficulty?: keyof typeof DIFFICULTY_CLASS;
  targetCharacters?: string[]; // Character IDs or 'all'
  reason: string;
  advantage?: boolean;
  disadvantage?: boolean;
  secret?: boolean; // DM rolls secretly
}

export const callForRollAction: Action = {
  name: 'CALL_FOR_ROLL',
  description: 'Request dice rolls from players for ability checks, saves, or skills',
  
  similes: [
    'make a check',
    'roll for',
    'saving throw',
    'roll perception',
    'check your',
    'everyone roll',
  ],
  
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'I want to sneak past the guards.',
          action: 'CALL_FOR_ROLL',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'The torchlight casts long shadows along the corridor, and the guards seem distracted by their conversation.\n\n**Make a Stealth check.** The guards\' passive Perception is 12.\n\n Roll a d20 and add your Stealth modifier.',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'The trap triggers!',
          action: 'CALL_FOR_ROLL',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'A pressure plate clicks beneath your foot, and you hear a sharp hiss from the wall!\n\n**Everyone in the hallway: Make a Dexterity saving throw, DC 14!**\n\nRoll quickly - poison darts are about to fly!',
        },
      },
    ],
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const role = await runtime.getSetting('role');
    return role === 'dm';
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ) => {
    const params = (options ?? {}) as unknown as CallForRollParams;
    
    // Determine DC if difficulty level provided
    const dc = params.dc ?? (params.difficulty ? getDCByDifficulty(params.difficulty) : undefined);
    
    // Build the roll request message
    const rollRequest = buildRollRequest(params, dc);
    
    if (callback) {
      await callback({
        text: rollRequest,
      });
    }
    
    // Track pending rolls
    const rollPayload = {
      runtime,
      rollType: params.rollType,
      ability: params.ability,
      skill: params.skill,
      dc,
      targets: params.targetCharacters,
      reason: params.reason,
      timestamp: new Date(),
    };
    await runtime.emitEvent('roll_requested', rollPayload);
    
    return undefined;
  },
};

function buildRollRequest(params: CallForRollParams, dc?: number): string {
  let request = '';
  
  // Add narrative context
  if (params.reason) {
    // The reason should be narrated separately, this just builds the mechanical call
  }
  
  // Determine who needs to roll
  const whoRolls = params.targetCharacters?.includes('all') 
    ? '**Everyone**' 
    : params.targetCharacters 
      ? `**${params.targetCharacters.join(', ')}**`
      : '**You**';
  
  switch (params.rollType) {
    case 'ability_check':
      request = `${whoRolls}: Make ${getArticle(params.ability!)} **${params.ability} check**`;
      break;
      
    case 'saving_throw':
      request = `${whoRolls}: Make a **${params.ability} saving throw**`;
      break;
      
    case 'skill_check':
      request = `${whoRolls}: Make ${getArticle(params.skill!)} **${params.skill} check**`;
      if (params.ability) {
        request += ` (${params.ability})`;
      }
      break;
      
    case 'attack':
      request = `${whoRolls}: Make an **attack roll**`;
      break;
      
    case 'initiative':
      request = `${whoRolls}: **Roll initiative!**`;
      break;
      
    case 'death_save':
      request = `${whoRolls}: Make a **death saving throw**`;
      break;
      
    default:
      request = `${whoRolls}: Make a roll`;
  }
  
  // Add DC if applicable and not secret
  if (dc !== undefined && !params.secret) {
    request += `, **DC ${dc}**`;
  }
  
  request += '!';
  
  // Add advantage/disadvantage
  if (params.advantage) {
    request += '\n\n*Roll with advantage (roll twice, take the higher result).*';
  } else if (params.disadvantage) {
    request += '\n\n*Roll with disadvantage (roll twice, take the lower result).*';
  }
  
  // Add dice instructions
  request += '\n\nRoll a d20 and add your modifier.';
  
  return request;
}

function getArticle(word: string): string {
  const vowels = ['a', 'e', 'i', 'o', 'u'];
  return vowels.includes(word.toLowerCase()[0]) ? 'an' : 'a';
}

export default callForRollAction;
