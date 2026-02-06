/**
 * Explore Action
 * Handles exploration and investigation activities
 */

import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from '@elizaos/core';
import type { CharacterSheet } from '../../../types';

export type ExploreActivity =
  | 'look_around'
  | 'examine'
  | 'search'
  | 'listen'
  | 'investigate'
  | 'track'
  | 'scout';

export interface ExploreParams {
  activity?: ExploreActivity;
  target?: string;
}

export const exploreAction: Action = {
  name: 'EXPLORE',
  description: 'Explore and investigate the environment',
  
  similes: [
    'look',
    'examine',
    'search',
    'investigate',
    'check',
    'inspect',
    'scout',
  ],
  
  examples: [
    [
      {
        user: '{{user1}}',
        content: {
          text: 'You enter a dusty library filled with ancient tomes.',
        },
      },
      {
        user: '{{agentName}}',
        content: {
          text: 'My eyes widen at the sight of so much knowledge. I run my fingers along the spines of the nearest books, searching for anything that might be relevant to our quest. "There must be something useful here..."',
          action: 'EXPLORE',
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
    const params = options as ExploreParams;
    const characterSheet = await runtime.getSetting('characterSheet') as CharacterSheet | null;
    const personality = await runtime.getSetting('personality');
    
    if (!characterSheet) {
      if (callback) {
        await callback({
          text: 'I survey my surroundings...',
          type: 'error',
        });
      }
      return false;
    }
    
    // Generate exploration response
    const prompt = buildExplorePrompt(characterSheet, personality, message, params);
    
    const response = await runtime.useModel({
      prompt,
      context: state,
      maxTokens: 300,
    });
    
    // Determine what skill check might be needed
    const suggestedCheck = determineSuggestedCheck(params.activity, response.text);
    
    let finalResponse = response.text;
    
    if (suggestedCheck) {
      finalResponse += `\n\n*[${suggestedCheck} check may reveal more]*`;
    }
    
    if (callback) {
      await callback({
        text: finalResponse,
        type: 'exploration',
        metadata: {
          characterId: characterSheet.id,
          characterName: characterSheet.name,
          activity: params.activity || 'look_around',
          target: params.target,
          suggestedCheck,
        },
      });
    }
    
    await runtime.emit('exploration', {
      characterId: characterSheet.id,
      characterName: characterSheet.name,
      activity: params.activity,
      target: params.target,
      timestamp: new Date(),
    });
    
    return true;
  },
};

function buildExplorePrompt(
  sheet: CharacterSheet,
  personality: unknown,
  message: Memory,
  params: ExploreParams
): string {
  const msgText = typeof message.content === 'string'
    ? message.content
    : message.content?.text || '';
  
  // Determine character's observational strengths
  const perception = sheet.skills?.perception || sheet.abilities.wisdom.modifier;
  const investigation = sheet.skills?.investigation || sheet.abilities.intelligence.modifier;
  
  const observerType = perception >= investigation ? 'perceptive' : 'analytical';
  
  let activityGuidance = '';
  if (params.activity) {
    const guidance: Record<ExploreActivity, string> = {
      look_around: 'Take in the general surroundings.',
      examine: `Closely examine ${params.target || 'something specific'}.`,
      search: 'Actively search for something hidden or useful.',
      listen: 'Listen carefully for sounds or conversations.',
      investigate: 'Apply logic to understand what you observe.',
      track: 'Look for tracks, trails, or signs of passage.',
      scout: 'Survey ahead for potential dangers or points of interest.',
    };
    activityGuidance = guidance[params.activity] || '';
  }
  
  return `You are ${sheet.name}, a ${observerType} ${sheet.race} ${sheet.class}.

The DM describes: "${msgText}"

${activityGuidance ? activityGuidance + '\n' : ''}
Describe how your character explores or investigates in first person. Include:
1. What draws your attention (based on your character's interests)
2. How you approach the exploration
3. Any questions or concerns your character has

Be curious and in-character. Keep response to 2-3 sentences.`;
}

function determineSuggestedCheck(
  activity: ExploreActivity | undefined,
  responseText: string
): string | null {
  const lowerText = responseText.toLowerCase();
  
  // Activity-based suggestions
  if (activity === 'search') return 'Investigation or Perception';
  if (activity === 'listen') return 'perception';
  if (activity === 'investigate') return 'investigation';
  if (activity === 'track') return 'survival';
  if (activity === 'scout') return 'Stealth and Perception';
  
  // Content-based detection
  if (lowerText.includes('trap') || lowerText.includes('hidden')) {
    return 'Investigation or Perception';
  }
  if (lowerText.includes('magic') || lowerText.includes('arcane') || lowerText.includes('rune')) {
    return 'arcana';
  }
  if (lowerText.includes('tracks') || lowerText.includes('trail')) {
    return 'survival';
  }
  if (lowerText.includes('ancient') || lowerText.includes('historical')) {
    return 'history';
  }
  if (lowerText.includes('religious') || lowerText.includes('divine')) {
    return 'religion';
  }
  if (lowerText.includes('nature') || lowerText.includes('plant') || lowerText.includes('animal')) {
    return 'nature';
  }
  
  return null;
}

export default exploreAction;
