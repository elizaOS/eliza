/**
 * Control NPC Action
 * Manages NPC dialogue and behavior during roleplay
 */

import type { 
  Action, 
  IAgentRuntime, 
  Memory, 
  State, 
  HandlerCallback 
} from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import type { NPC } from '../../../types';

export interface ControlNPCParams {
  npcId: string;
  interactionType: 'dialogue' | 'action' | 'reaction' | 'inner_thought';
  playerMessage?: string;
  context?: string;
  emotionalState?: string;
}

export const controlNPCAction: Action = {
  name: 'CONTROL_NPC',
  description: 'Roleplay as an NPC, generating dialogue and actions in character',
  
  similes: [
    'speak as the NPC',
    'NPC responds',
    'what does the NPC say',
    'roleplay the character',
    'the NPC reacts',
  ],
  
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'I ask the bartender about the strange noises coming from the basement.',
          action: 'CONTROL_NPC',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'The dwarven bartender\'s polishing slows, and her jovial expression tightens almost imperceptibly. She glances toward the "Private" door before meeting your eyes.\n\n"Noises? Can\'t say I\'ve heard anything unusual," she says, her voice dropping lower. "Though if I were you, I\'d be more concerned with the road ahead than what might be in someone\'s cellar. Storm\'s coming, and the mountain passes get treacherous this time of year."\n\nShe resumes her polishing with renewed vigor, but you notice her knuckles have gone white around the tankard.',
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
    const params = (options ?? {}) as unknown as ControlNPCParams;
    
    // Get NPC data
    const npc = await getNPCData(runtime, params.npcId);
    
    if (!npc) {
      if (callback) {
        await callback({
          text: 'Unable to find NPC information.',
        });
      }
      return { success: false };
    }
    
    // Build the NPC roleplay prompt
    const prompt = buildNPCPrompt(npc, params);
    
    // Generate NPC response
    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      maxTokens: 400,
    });
    
    if (callback) {
      await callback({
        text: response,
      });
    }
    
    // Log the interaction
    const interactionPayload = {
      runtime,
      npcId: params.npcId,
      npcName: npc.name,
      interactionType: params.interactionType,
      playerMessage: params.playerMessage,
      npcResponse: response,
      timestamp: new Date(),
    };
    await runtime.emitEvent('npc_interaction', interactionPayload);
    
    return undefined;
  },
};

async function getNPCData(
  runtime: IAgentRuntime,
  npcId: string
): Promise<NPC | null> {
  const raw = runtime.getSetting('campaignState');
  if (raw && typeof raw === 'string') {
    try {
      const state = JSON.parse(raw) as { npcs?: Record<string, NPC> };
      return state.npcs?.[npcId] || null;
    } catch {
      return null;
    }
  }
  return null;
}

function buildNPCPrompt(npc: NPC, params: ControlNPCParams): string {
  let prompt = `You are roleplaying as an NPC in a D&D game. Stay completely in character.\n\n`;
  
  prompt += `=== NPC PROFILE ===\n`;
  prompt += `Name: ${npc.name}\n`;
  if (npc.race) prompt += `Race: ${npc.race}\n`;
  if (npc.occupation) prompt += `Occupation: ${npc.occupation}\n`;
  if (npc.description) prompt += `Description: ${npc.description}\n`;
  if (npc.personality) prompt += `Personality: ${npc.personality}\n`;
  if (npc.motivation) prompt += `Motivation: ${npc.motivation}\n`;
  
  // Disposition affects tone
  const disposition = npc.partyDisposition ?? 50;
  const dispositionDesc = disposition > 50 ? 'friendly toward the party' 
    : disposition < -50 ? 'hostile toward the party'
    : disposition > 0 ? 'somewhat positive toward the party'
    : disposition < 0 ? 'somewhat wary of the party'
    : 'neutral toward the party';
  prompt += `Current disposition: ${dispositionDesc}\n`;
  
  // Include secrets they might hint at
  if (npc.secrets && npc.secrets.length > 0) {
    prompt += `\nSecrets (may hint at but never directly reveal):\n`;
    for (const secret of npc.secrets) {
      prompt += `- ${secret}\n`;
    }
  }
  
  prompt += `\n=== INTERACTION ===\n`;
  prompt += `Type: ${params.interactionType}\n`;
  
  if (params.emotionalState) {
    prompt += `Emotional state: ${params.emotionalState}\n`;
  }
  
  if (params.context) {
    prompt += `Context: ${params.context}\n`;
  }
  
  if (params.playerMessage) {
    prompt += `\nPlayer says/does: "${params.playerMessage}"\n`;
  }
  
  prompt += `\n=== INSTRUCTIONS ===\n`;
  
  switch (params.interactionType) {
    case 'dialogue':
      prompt += `Respond in character with dialogue. Include subtle body language and tone cues. `;
      prompt += `The response should feel natural and reveal personality through speech patterns.`;
      break;
    case 'action':
      prompt += `Describe what the NPC does. Include their demeanor and any tells that reveal their emotional state.`;
      break;
    case 'reaction':
      prompt += `Show the NPC's immediate reaction to what happened. Include both physical and emotional responses.`;
      break;
    case 'inner_thought':
      prompt += `Describe what the NPC is thinking but not saying. This is for DM reference only.`;
      break;
  }
  
  prompt += `\n\nStay in character. Be consistent with their established personality. Never break character.`;
  
  return prompt;
}

export default controlNPCAction;
