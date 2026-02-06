/**
 * Respond to Party Action
 * Handles interactions with other party members
 */

import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
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
        user: '{{user1}}',
        content: {
          text: 'Thordak the Dwarf Fighter says: "I say we charge in! No plan survives contact with the enemy anyway."',
        },
      },
      {
        user: '{{agentName}}',
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
    state: State,
    options: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    const params = options as RespondToPartyParams;
    const characterSheet = await runtime.getSetting('characterSheet') as CharacterSheet | null;
    const personality = await runtime.getSetting('personality');
    
    if (!characterSheet) {
      if (callback) {
        await callback({
          text: 'I nod thoughtfully...',
          type: 'error',
        });
      }
      return false;
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
    
    const response = await runtime.useModel({
      prompt,
      context: state,
      maxTokens: 300,
    });
    
    if (callback) {
      await callback({
        text: response.text,
        type: 'party_interaction',
        metadata: {
          characterId: characterSheet.id,
          characterName: characterSheet.name,
          respondingTo: params.partyMemberName,
          topic: params.topic,
        },
      });
    }
    
    await runtime.emit('party_interaction', {
      characterId: characterSheet.id,
      characterName: characterSheet.name,
      respondingTo: params.partyMemberName,
      dialogue: response.text,
      timestamp: new Date(),
    });
    
    return true;
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
