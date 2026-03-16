/**
 * Advance Time Action
 * Manages in-game time progression
 */

import type { 
  Action, 
  IAgentRuntime, 
  Memory, 
  State, 
  HandlerCallback 
} from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import type { GameTime } from '../../../types';
import { advanceGameTime, formatGameTime, getTimeOfDay } from '../../../types';

export interface AdvanceTimeParams {
  amount: number;
  unit: 'minutes' | 'hours' | 'days';
  activity?: string;
  narrateTimePassage?: boolean;
}

export const advanceTimeAction: Action = {
  name: 'ADVANCE_TIME',
  description: 'Progress in-game time for travel, rest, or activities',
  
  similes: [
    'time passes',
    'hours later',
    'the next morning',
    'after some time',
    'wait until',
  ],
  
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'We take a long rest at the inn.',
          action: 'ADVANCE_TIME',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'You settle into the comfortable beds at the Silver Stag Inn, the events of the day weighing heavily on your minds. The innkeeper brings warm meals and fresh water, and the fire crackles softly as exhaustion claims you one by one.\n\n**8 hours pass...**\n\n*Dawn breaks on Day 15.*\n\nYou wake to the smell of bacon and fresh bread drifting up from below. Sunlight streams through the window shutters, and you feel refreshed and ready to face whatever challenges lie ahead.\n\n*All HP restored. Hit dice recovered. Spell slots restored.*',
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
    const params = (options ?? {}) as unknown as AdvanceTimeParams;
    
    // Get current game time
    const raw = runtime.getSetting('campaignState');
    let campaignState: { currentTime: GameTime } | null = null;
    if (raw && typeof raw === 'string') {
      try {
        campaignState = JSON.parse(raw) as { currentTime: GameTime };
      } catch {
        campaignState = null;
      }
    }
    
    const currentTime = campaignState?.currentTime || {
      year: 1490,
      month: 1,
      day: 1,
      hour: 8,
      minute: 0,
    };
    
    // Calculate minutes to advance
    const minutesToAdvance = 
      params.unit === 'minutes' ? params.amount :
      params.unit === 'hours' ? params.amount * 60 :
      params.amount * 24 * 60;
    
    // Advance time
    const newTime = advanceGameTime(currentTime, minutesToAdvance);
    
    // Update campaign state
    if (campaignState) {
      campaignState.currentTime = newTime;
      runtime.setSetting('campaignState', JSON.stringify(campaignState));
    }
    
    // Generate time passage narrative if requested
    let narrative = '';
    
    if (params.narrateTimePassage) {
      narrative = await generateTimeNarrative(runtime, state, currentTime, newTime, params);
    } else {
      narrative = formatTimePassage(currentTime, newTime, params);
    }
    
    if (callback) {
      await callback({
        text: narrative,
      });
    }
    
    // Emit time advanced event
    const timePayload = {
      runtime,
      previousTime: currentTime,
      newTime,
      minutesAdvanced: minutesToAdvance,
      activity: params.activity,
      timestamp: new Date(),
    };
    await runtime.emitEvent('time_advanced', timePayload);
    
    return undefined;
  },
};

function formatTimePassage(
  _oldTime: GameTime,
  newTime: GameTime,
  params: AdvanceTimeParams
): string {
  const timeOfDay = getTimeOfDay(newTime.hour);
  const emoji = getTimeEmoji(newTime.hour);
  
  let result = `\n**${params.amount} ${params.unit} pass${params.amount === 1 ? 'es' : ''}...**\n\n`;
  result += `${emoji} *${getTimeDescription(timeOfDay)} on Day ${newTime.day}.*`;
  
  return result;
}

async function generateTimeNarrative(
  runtime: IAgentRuntime,
  _state: State | undefined,
  oldTime: GameTime,
  newTime: GameTime,
  params: AdvanceTimeParams
): Promise<string> {
  const prompt = `Generate a brief, atmospheric description of time passing in a D&D game.\n\n` +
    `Time passing: ${params.amount} ${params.unit}\n` +
    `Activity: ${params.activity || 'unspecified'}\n` +
    `Starting time: ${formatGameTime(oldTime)} (${getTimeOfDay(oldTime.hour)})\n` +
    `Ending time: ${formatGameTime(newTime)} (${getTimeOfDay(newTime.hour)})\n\n` +
    `Write 1-2 evocative sentences describing the passage of time and transition between scenes.`;
  
  const response = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt,
    maxTokens: 150,
  });
  
  const emoji = getTimeEmoji(newTime.hour);
  
  return response + `\n\n${emoji} *${getTimeDescription(getTimeOfDay(newTime.hour))} on Day ${newTime.day}.*`;
}

function getTimeEmoji(hour: number): string {
  if (hour >= 5 && hour < 7) return '\u{1F305}'; // Dawn
  if (hour >= 7 && hour < 12) return '\u{2600}\u{FE0F}'; // Morning
  if (hour >= 12 && hour < 14) return '\u{1F31E}'; // Midday
  if (hour >= 14 && hour < 17) return '\u{2600}\u{FE0F}'; // Afternoon
  if (hour >= 17 && hour < 20) return '\u{1F306}'; // Evening
  if (hour >= 20 && hour < 22) return '\u{1F305}'; // Dusk
  return '\u{1F319}'; // Night
}

function getTimeDescription(timeOfDay: string): string {
  switch (timeOfDay) {
    case 'dawn': return 'Dawn breaks';
    case 'morning': return 'Morning light';
    case 'midday': return 'The sun is high';
    case 'afternoon': return 'Afternoon';
    case 'evening': return 'Evening approaches';
    case 'dusk': return 'Dusk settles';
    case 'night': return 'Night has fallen';
    default: return 'Time passes';
  }
}

export default advanceTimeAction;
