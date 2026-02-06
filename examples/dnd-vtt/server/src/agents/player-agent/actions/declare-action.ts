/**
 * Declare Action
 * Primary action for player characters to state their intended action
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

export type ActionCategory = 
  | 'attack'
  | 'spell'
  | 'skill'
  | 'movement'
  | 'interaction'
  | 'item'
  | 'help'
  | 'other';

export interface DeclaredAction {
  category: ActionCategory;
  description: string;
  target?: string;
  reasoning?: string;
  rollType?: string;
  abilityUsed?: string;
}

export const declareActionAction: Action = {
  name: 'DECLARE_ACTION',
  description: 'Declare an intended action in or out of combat',
  
  similes: [
    'I want to',
    'I try to',
    'I attack',
    'I cast',
    'I move',
    'I check',
    'let me',
  ],
  
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'The goblin raises its weapon threateningly.',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: `I grip my sword tightly and step into a defensive stance. "You'll regret threatening us, creature!" I swing at the goblin, aiming for its weapon arm.`,
          action: 'DECLARE_ACTION',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'You notice a strange symbol carved into the wall.',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: `I lean in closer, my curiosity piqued. "This marking... I've seen something similar in my studies." I try to recall what I know about this symbol.`,
          action: 'DECLARE_ACTION',
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
    // Get character context
    const characterSheet = await runtime.getSetting('characterSheet') as unknown as CharacterSheet | null;
    const personality = await runtime.getSetting('personality');
    const combatState = await runtime.getSetting('combatState') as unknown as { isActive?: boolean } | null;
    
    if (!characterSheet) {
      if (callback) {
        await callback({
          text: 'I seem to have lost track of who I am...',
          type: 'error',
        });
      }
      return undefined;
    }
    
    // Analyze the situation to determine best action
    const situationContext = buildSituationContext(state, combatState);
    
    // Generate the character's response
    const prompt = buildActionPrompt(characterSheet, personality, situationContext, message);
    
    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      maxTokens: 400,
    });
    
    // Parse the action from the response
    const responseText = String(response ?? '');
    const declaredAction = parseActionFromResponse(responseText);
    
    if (callback) {
      await callback({
        text: responseText,
        type: 'player_action',
        metadata: {
          characterId: characterSheet.id,
          characterName: characterSheet.name,
          actionCategory: declaredAction.category,
          actionDescription: declaredAction.description,
          inCombat: Boolean(combatState?.isActive),
        },
      });
    }
    
    // Emit event for DM to process
    runtime.emitEvent?.('player_action_declared' as any, {
      characterId: characterSheet.id,
      characterName: characterSheet.name,
      action: declaredAction,
      rawText: responseText,
      timestamp: new Date(),
    });
    
    return undefined;
  },
};

function buildSituationContext(state: State | undefined, combatState: unknown): string {
  let context = '';
  
  // Add any relevant state information
  if (combatState && typeof combatState === 'object' && 'isActive' in combatState) {
    context += 'You are currently in combat. ';
    context += 'Consider your available actions: Attack, Cast a Spell, Dash, Disengage, Dodge, Help, Hide, Ready, or Use an Object. ';
  } else {
    context += 'You are in exploration/social mode. ';
    context += 'Consider what your character would naturally do in this situation. ';
  }
  
  return context;
}

function buildActionPrompt(
  sheet: CharacterSheet,
  personality: unknown,
  situation: string,
  message: Memory
): string {
  const msgText = typeof message.content === 'string' 
    ? message.content 
    : message.content?.text || '';
  
  return `You are ${sheet.name}, a ${sheet.race} ${sheet.class}.

${situation}

The DM says: "${msgText}"

Respond in first person as your character. Describe what you do and say, staying true to your personality. Include:
1. Your character's thoughts or reactions (brief)
2. Any dialogue you speak (in quotes)
3. The action you take (be specific)

Keep your response to 2-3 sentences. Be decisive and in-character.`;
}

function parseActionFromResponse(text: string): DeclaredAction {
  // Simple heuristic parsing - in production would be more sophisticated
  const lowerText = text.toLowerCase();
  
  let category: ActionCategory = 'other';
  let rollType: string | undefined;
  
  if (lowerText.includes('attack') || lowerText.includes('strike') || lowerText.includes('swing') || lowerText.includes('hit')) {
    category = 'attack';
    rollType = 'attack_roll';
  } else if (lowerText.includes('cast') || lowerText.includes('spell')) {
    category = 'spell';
    rollType = 'spell';
  } else if (lowerText.includes('check') || lowerText.includes('try to') || lowerText.includes('attempt')) {
    category = 'skill';
    rollType = 'skill_check';
  } else if (lowerText.includes('move') || lowerText.includes('run') || lowerText.includes('walk') || lowerText.includes('step')) {
    category = 'movement';
  } else if (lowerText.includes('talk') || lowerText.includes('speak') || lowerText.includes('ask') || lowerText.includes('say')) {
    category = 'interaction';
  } else if (lowerText.includes('use') || lowerText.includes('drink') || lowerText.includes('pull out')) {
    category = 'item';
  } else if (lowerText.includes('help') || lowerText.includes('assist')) {
    category = 'help';
  }
  
  return {
    category,
    description: text,
    rollType,
  };
}

export default declareActionAction;
