/**
 * Narrate Scene Action
 * Generates narrative descriptions for game events
 */

import type { 
  Action, 
  IAgentRuntime, 
  Memory, 
  State, 
  HandlerCallback 
} from '@elizaos/core';
import { ModelType } from '@elizaos/core';

export interface NarrateSceneParams {
  sceneType: 'transition' | 'discovery' | 'combat_start' | 'combat_end' | 'rest' | 'revelation' | 'custom';
  context: string;
  mood?: 'tense' | 'peaceful' | 'mysterious' | 'triumphant' | 'somber' | 'urgent';
  focusCharacters?: string[];
  sensoryDetails?: {
    sight?: string;
    sound?: string;
    smell?: string;
    touch?: string;
    taste?: string;
  };
}

export const narrateSceneAction: Action = {
  name: 'NARRATE_SCENE',
  description: 'Generate vivid narrative description for a game scene or event',
  
  similes: [
    'describe what happens',
    'narrate the scene',
    'set the scene',
    'paint a picture',
    'tell the players what they see',
  ],
  
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'The party enters the abandoned temple.',
          action: 'NARRATE_SCENE',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'As you push open the heavy oak doors, a gust of stale air rushes past you, carrying the scent of centuries-old incense and something else... decay. Shafts of pale moonlight pierce through cracks in the vaulted ceiling, illuminating motes of dust that dance in the stillness. The temple\'s nave stretches before you, its stone pews overturned and scattered. At the far end, the altar stands untouched, and upon it, a faint blue glow pulses rhythmically, like a slow heartbeat.',
        },
      },
    ],
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // DM can always narrate scenes
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
    const params = (options ?? {}) as unknown as NarrateSceneParams;
    
    // Build the narrative prompt based on scene type and context
    const narrativePrompt = buildNarrativePrompt(params);
    
    // Generate the narrative using the model
    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: narrativePrompt,
      maxTokens: 500,
    });
    
    if (callback) {
      await callback({
        text: response,
      });
    }
    
    // Log the scene to campaign memory
    const scenePayload = {
      runtime,
      sceneType: params.sceneType,
      context: params.context,
      narration: response,
      timestamp: new Date(),
    };
    await runtime.emitEvent('scene_narrated', scenePayload);
    
    return undefined;
  },
};

function buildNarrativePrompt(params: NarrateSceneParams): string {
  let prompt = `Generate a vivid, immersive narrative description for a D&D scene.\n\n`;
  
  prompt += `Scene Type: ${params.sceneType}\n`;
  prompt += `Context: ${params.context}\n`;
  
  if (params.mood) {
    prompt += `Mood: ${params.mood}\n`;
  }
  
  if (params.focusCharacters && params.focusCharacters.length > 0) {
    prompt += `Focus on characters: ${params.focusCharacters.join(', ')}\n`;
  }
  
  if (params.sensoryDetails) {
    prompt += `\nInclude these sensory details:\n`;
    if (params.sensoryDetails.sight) prompt += `- Sight: ${params.sensoryDetails.sight}\n`;
    if (params.sensoryDetails.sound) prompt += `- Sound: ${params.sensoryDetails.sound}\n`;
    if (params.sensoryDetails.smell) prompt += `- Smell: ${params.sensoryDetails.smell}\n`;
    if (params.sensoryDetails.touch) prompt += `- Touch: ${params.sensoryDetails.touch}\n`;
    if (params.sensoryDetails.taste) prompt += `- Taste: ${params.sensoryDetails.taste}\n`;
  }
  
  prompt += `\nWrite 2-4 paragraphs of evocative description. Use second person ("you"). Engage multiple senses. Create atmosphere appropriate to the mood.`;
  
  return prompt;
}

export default narrateSceneAction;
