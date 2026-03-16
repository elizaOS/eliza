/**
 * Interact with NPC Action
 * Handles social interactions with NPCs
 */

import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  ModelType,
} from '@elizaos/core';
import type { CharacterSheet } from '../../../types';
import { getAbilityScore } from '../../../types';

export type InteractionType = 
  | 'talk'
  | 'persuade'
  | 'deceive'
  | 'intimidate'
  | 'gather_info'
  | 'bargain'
  | 'request';

export interface InteractWithNPCParams {
  npcName?: string;
  interactionType?: InteractionType;
  dialogue?: string;
}

export const interactWithNPCAction: Action = {
  name: 'INTERACT_WITH_NPC',
  description: 'Engage in social interaction with an NPC',
  
  similes: [
    'talk to',
    'speak with',
    'ask',
    'tell',
    'convince',
    'persuade',
    'intimidate',
    'bargain',
  ],
  
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'The merchant eyes you suspiciously. "What do you want?"',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'I put on my most charming smile and lean against the counter. "Just a humble traveler looking for supplies, friend. I heard you have the finest goods in town - and I have coin to spend."',
          action: 'INTERACT_WITH_NPC',
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
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ) => {
    const params = (options ?? {}) as unknown as InteractWithNPCParams;
    const characterSheet = await runtime.getSetting('characterSheet') as unknown as CharacterSheet | null;
    const personality = await runtime.getSetting('personality');
    
    if (!characterSheet) {
      if (callback) {
        await callback({
          text: 'I find myself at a loss for words...',
          type: 'error',
        });
      }
      return undefined;
    }
    
    // Generate the character's social response
    const prompt = buildSocialPrompt(characterSheet, personality, message, params);
    
    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      maxTokens: 350,
    });
    
    // Determine if this requires a roll
    const responseText = String(response ?? '');
    const rollNeeded = detectRollNeeded(responseText, params.interactionType);
    
    let finalResponse = responseText;
    
    if (rollNeeded) {
      finalResponse += `\n\n*[${rollNeeded.skillName} check may be required]*`;
    }
    
    if (callback) {
      await callback({
        text: finalResponse,
        type: 'npc_interaction',
        metadata: {
          characterId: characterSheet.id,
          characterName: characterSheet.name,
          interactionType: params.interactionType || detectInteractionType(responseText),
          npcName: params.npcName,
          rollNeeded,
        },
      });
    }
    
    runtime.emitEvent?.('npc_interaction' as any, {
      characterId: characterSheet.id,
      characterName: characterSheet.name,
      interactionType: params.interactionType,
      dialogue: responseText,
      timestamp: new Date(),
    });
    
    return undefined;
  },
};

function buildSocialPrompt(
  sheet: CharacterSheet,
  personality: unknown,
  message: Memory,
  params: InteractWithNPCParams
): string {
  const msgText = typeof message.content === 'string'
    ? message.content
    : message.content?.text || '';
  
  const charismaScore = getAbilityScore(sheet.abilities.charisma);
  const charismaDesc = charismaScore >= 16 ? 'naturally charming'
    : charismaScore >= 12 ? 'reasonably likeable'
    : charismaScore >= 8 ? 'average in social situations'
    : 'socially awkward';
  
  let interactionGuidance = '';
  if (params.interactionType) {
    const guidance: Record<InteractionType, string> = {
      talk: 'Have a normal conversation.',
      persuade: 'Try to convince them through reason and charm.',
      deceive: 'Attempt to mislead or lie convincingly.',
      intimidate: 'Use threats or force of personality to pressure them.',
      gather_info: 'Subtly extract information from them.',
      bargain: 'Negotiate for better terms or prices.',
      request: 'Ask them for something specific.',
    };
    interactionGuidance = guidance[params.interactionType] || '';
  }
  
  return `You are ${sheet.name}, a ${sheet.race} ${sheet.class}. You are ${charismaDesc}.

${interactionGuidance}

The NPC says/does: "${msgText}"

Respond in first person as your character. Include:
1. Your character's dialogue (in quotes)
2. Any body language or actions
3. Stay true to your personality

Be natural and in-character. Keep response to 2-3 sentences.`;
}

function detectRollNeeded(
  responseText: string,
  explicitType?: InteractionType
): { skillName: string; type: string } | null {
  const lowerText = responseText.toLowerCase();
  
  // Check for explicit interaction types first
  if (explicitType === 'persuade') {
    return { skillName: 'persuasion', type: 'persuasion' };
  }
  if (explicitType === 'deceive') {
    return { skillName: 'deception', type: 'deception' };
  }
  if (explicitType === 'intimidate') {
    return { skillName: 'intimidation', type: 'intimidation' };
  }
  
  // Detect from response content
  if (lowerText.includes('convince') || lowerText.includes('persuade') || lowerText.includes('plead')) {
    return { skillName: 'persuasion', type: 'persuasion' };
  }
  if (lowerText.includes('lie') || lowerText.includes('mislead') || lowerText.includes('bluff')) {
    return { skillName: 'deception', type: 'deception' };
  }
  if (lowerText.includes('threaten') || lowerText.includes('intimidate') || lowerText.includes('demand')) {
    return { skillName: 'intimidation', type: 'intimidation' };
  }
  if (lowerText.includes('sense') || lowerText.includes('read') || lowerText.includes('suspicious')) {
    return { skillName: 'insight', type: 'insight' };
  }
  
  return null;
}

function detectInteractionType(text: string): InteractionType {
  const lowerText = text.toLowerCase();
  
  if (lowerText.includes('lie') || lowerText.includes('mislead')) return 'deceive';
  if (lowerText.includes('threaten') || lowerText.includes('intimidate')) return 'intimidate';
  if (lowerText.includes('convince') || lowerText.includes('persuade')) return 'persuade';
  if (lowerText.includes('ask about') || lowerText.includes('inquire')) return 'gather_info';
  if (lowerText.includes('negotiate') || lowerText.includes('bargain')) return 'bargain';
  if (lowerText.includes('request') || lowerText.includes('could you')) return 'request';
  
  return 'talk';
}

export default interactWithNPCAction;
