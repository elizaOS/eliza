/**
 * Adjudicate Action
 * Resolves player actions and determines outcomes based on rolls
 */

import type { 
  Action, 
  IAgentRuntime, 
  Memory, 
  State, 
  HandlerCallback 
} from '@elizaos/core';
import { ModelType } from '@elizaos/core';

export interface AdjudicateActionParams {
  characterId: string;
  characterName: string;
  attemptedAction: string;
  rollResult: number;
  rollType: string;
  dc?: number;
  context?: string;
}

export const adjudicateActionAction: Action = {
  name: 'ADJUDICATE_ACTION',
  description: 'Determine the outcome of a player action based on their roll',
  
  similes: [
    'resolve the roll',
    'what happens',
    'determine outcome',
    'success or failure',
    'result of the check',
  ],
  
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'I rolled a 15 on my Stealth check.',
          action: 'ADJUDICATE_ACTION',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'You press yourself against the cold stone wall, timing your movements with the flickering torchlight. The guards continue their idle chatter, completely unaware of your presence as you slip past. You reach the far end of the corridor undetected.\n\n**Stealth check: 15 vs DC 12 - Success!**\n\nYou now stand before an ornate wooden door, its surface carved with symbols you don\'t recognize. What do you do?',
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
    const params = (options ?? {}) as unknown as AdjudicateActionParams;
    
    // Determine success/failure
    const success = params.dc !== undefined ? params.rollResult >= params.dc : true;
    const criticalSuccess = params.rollResult >= 20;
    const criticalFailure = params.rollResult <= 1;
    
    // Generate the outcome narrative
    const outcome = await generateOutcome(runtime, params, success, criticalSuccess, criticalFailure);
    
    if (callback) {
      await callback({
        text: outcome,
      });
    }
    
    // Log the resolution
    const resolvedPayload = {
      runtime,
      characterId: params.characterId,
      characterName: params.characterName,
      action: params.attemptedAction,
      rollResult: params.rollResult,
      dc: params.dc,
      success,
      timestamp: new Date(),
    };
    await runtime.emitEvent('action_resolved', resolvedPayload);
    
    return undefined;
  },
};

async function generateOutcome(
  runtime: IAgentRuntime,
  params: AdjudicateActionParams,
  success: boolean,
  criticalSuccess: boolean,
  criticalFailure: boolean
): Promise<string> {
  // Build prompt for narrative outcome
  let prompt = `Generate a narrative outcome for this D&D action resolution:\n\n`;
  prompt += `Character: ${params.characterName}\n`;
  prompt += `Attempted Action: ${params.attemptedAction}\n`;
  prompt += `Roll Type: ${params.rollType}\n`;
  prompt += `Roll Result: ${params.rollResult}`;
  
  if (params.dc !== undefined) {
    prompt += ` vs DC ${params.dc}`;
  }
  
  prompt += `\n`;
  
  if (criticalSuccess) {
    prompt += `Outcome: CRITICAL SUCCESS - describe an exceptionally positive outcome\n`;
  } else if (criticalFailure) {
    prompt += `Outcome: CRITICAL FAILURE - describe a comedically bad or dramatically unfortunate outcome\n`;
  } else if (success) {
    prompt += `Outcome: SUCCESS - describe the character succeeding at their intended action\n`;
  } else {
    prompt += `Outcome: FAILURE - describe the character failing, but not catastrophically\n`;
  }
  
  if (params.context) {
    prompt += `Context: ${params.context}\n`;
  }
  
  prompt += `\nWrite 1-2 paragraphs describing what happens. Be vivid but concise. End with a hook that invites the next action.`;
  
  const response = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt,
    maxTokens: 300,
  });
  
  // Add mechanical summary
  let mechanical = `\n\n**${params.rollType}: ${params.rollResult}`;
  
  if (params.dc !== undefined) {
    mechanical += ` vs DC ${params.dc}`;
  }
  
  if (criticalSuccess) {
    mechanical += ` - Critical Success!**`;
  } else if (criticalFailure) {
    mechanical += ` - Critical Failure!**`;
  } else if (success) {
    mechanical += ` - Success!**`;
  } else {
    mechanical += ` - Failure.**`;
  }
  
  return response + mechanical;
}

export default adjudicateActionAction;
