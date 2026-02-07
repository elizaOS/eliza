/**
 * Respond to Party Action
 * Handles interactions with other party members
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

export interface RespondToPartyParams {
  partyMemberName?: string;
  topic?: string;
}

export const respondToPartyAction: Action = {
  name: 'RESPOND_TO_PARTY',
  description: 'Respond to or interact with other party members',
  
  similes: [
    'respond to',
    'tell the party',
    'agree with',
    'disagree with',
    'suggest to',
    'ask the group',
  ],
  
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Thordak the Dwarf Fighter says: "I say we charge in! No plan survives contact with the enemy anyway."',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'I place a cautionary hand on Thordak\'s shoulder. "My friend, your courage is admirable, but perhaps we should at least know what we\'re charging into? A quick scout could save us considerable pain."',
          action: 'RESPOND_TO_PARTY',
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
    const params = options as unknown as RespondToPartyParams;
    const characterSheet = await runtime.getSetting('characterSheet') as unknown as CharacterSheet | null;
    const personality = await runtime.getSetting('personality');
    
    if (!characterSheet) {
      if (callback) {
        await callback({
          text: 'I nod thoughtfully...',
          type: 'error',
        });
      }
      return undefined;
    }
    
    // Get party relationship context
    const partyRelationships = await runtime.getSetting('partyRelationships') || {};
    
    const prompt = buildPartyResponsePrompt(
      characterSheet,
      personality,
      message,
      params,
      partyRelationships
    );
    
    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      maxTokens: 300,
    });
    
    const responseText = String(response ?? '');
    
    if (callback) {
      await callback({
        text: responseText,
        type: 'party_interaction',
        metadata: {
          characterId: characterSheet.id,
          characterName: characterSheet.name,
          respondingTo: params.partyMemberName,
          topic: params.topic,
        },
      });
    }
    
    runtime.emitEvent?.('party_interaction' as any, {
      characterId: characterSheet.id,
      characterName: characterSheet.name,
      respondingTo: params.partyMemberName,
      dialogue: responseText,
      timestamp: new Date(),
    });
    
    return undefined;
  },
};

function buildPartyResponsePrompt(
  sheet: CharacterSheet,
  personality: unknown,
  message: Memory,
  params: RespondToPartyParams,
  relationships: Record<string, unknown>
): string {
  const msgText = typeof message.content === 'string'
    ? message.content
    : message.content?.text || '';
  
  // Extract personality archetype if available
  const archetype = (personality as { archetype?: string })?.archetype || 'adventurer';
  
  // Get relationship context for the party member
  let relationshipContext = '';
  if (params.partyMemberName && relationships[params.partyMemberName]) {
    relationshipContext = `You have an established relationship with ${params.partyMemberName}. `;
  }
  
  return `You are ${sheet.name}, a ${archetype} ${sheet.race} ${sheet.class}.

${relationshipContext}

A party member says: "${msgText}"

Respond naturally as your character. Consider:
1. Your character's personality and how they'd react
2. The dynamics within the party
3. Whether you agree, disagree, or have questions
4. Contributing meaningfully to the group decision

Speak in first person. Include dialogue and brief actions. Keep response to 2-3 sentences.`;
}

export default respondToPartyAction;
