/**
 * Combat State Provider
 * Provides current combat encounter state to the DM agent
 */

import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import type { ConditionName } from '../../../types';

export interface Combatant {
  id: string;
  name: string;
  type: 'pc' | 'npc' | 'monster';
  initiative: number;
  hp: { current: number; max: number; temp: number };
  ac: number;
  conditions: ConditionName[];
  isConcentrating?: boolean;
  deathSaves?: { successes: number; failures: number };
  position?: { x: number; y: number };
}

export interface CombatState {
  isActive: boolean;
  round: number;
  turnIndex: number;
  initiativeOrder: Combatant[];
  currentCombatant: Combatant | null;
  battleMapId?: string;
  environmentalEffects?: string[];
  defeatedCombatants: Combatant[];
}

export const combatStateProvider: Provider = {
  name: 'combatState',
  description: 'Provides current combat encounter status and initiative order',
  
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const raw = runtime.getSetting('combatState');
    let combatState: CombatState | null = null;
    if (raw && typeof raw === 'string') {
      try {
        combatState = JSON.parse(raw) as CombatState;
      } catch {
        combatState = null;
      }
    }
    
    if (!combatState || !combatState.isActive) {
      return { text: 'No active combat encounter.' };
    }
    
    let context = `## Combat Encounter - Round ${combatState.round}\n\n`;
    
    // Current turn
    if (combatState.currentCombatant) {
      context += `### Current Turn: ${combatState.currentCombatant.name}\n`;
      context += formatCombatantStatus(combatState.currentCombatant);
      context += '\n\n';
    }
    
    // Initiative order
    context += `### Initiative Order\n`;
    context += '| # | Name | Initiative | HP | AC | Conditions |\n';
    context += '|---|------|------------|----|----|------------|\n';
    
    combatState.initiativeOrder.forEach((combatant, index) => {
      const isCurrent = index === combatState!.turnIndex;
      const marker = isCurrent ? '>' : `${index + 1}`;
      const hpDisplay = combatant.type === 'monster' 
        ? getHealthDescription(combatant.hp.current, combatant.hp.max)
        : `${combatant.hp.current}/${combatant.hp.max}`;
      const conditions = combatant.conditions.length > 0 
        ? combatant.conditions.join(', ')
        : '-';
      
      context += `| ${marker} | ${combatant.name} | ${combatant.initiative} | ${hpDisplay} | ${combatant.ac} | ${conditions} |\n`;
    });
    
    context += '\n';
    
    // Environmental effects
    if (combatState.environmentalEffects && combatState.environmentalEffects.length > 0) {
      context += `### Environmental Effects\n`;
      context += combatState.environmentalEffects.map(e => `- ${e}`).join('\n');
      context += '\n\n';
    }
    
    // Defeated combatants
    if (combatState.defeatedCombatants.length > 0) {
      context += `### Defeated\n`;
      context += combatState.defeatedCombatants.map(c => `- ${c.name}`).join('\n');
      context += '\n';
    }
    
    return { text: context };
  },
};

function formatCombatantStatus(combatant: Combatant): string {
  let status = '';
  
  status += `- **HP:** ${combatant.hp.current}/${combatant.hp.max}`;
  if (combatant.hp.temp > 0) {
    status += ` (+${combatant.hp.temp} temp)`;
  }
  status += `\n- **AC:** ${combatant.ac}`;
  
  if (combatant.conditions.length > 0) {
    status += `\n- **Conditions:** ${combatant.conditions.join(', ')}`;
  }
  
  if (combatant.isConcentrating) {
    status += `\n- **Concentrating** on a spell`;
  }
  
  if (combatant.deathSaves) {
    status += `\n- **Death Saves:** S:${combatant.deathSaves.successes} F:${combatant.deathSaves.failures}`;
  }
  
  return status;
}

function getHealthDescription(current: number, max: number): string {
  const percentage = max > 0 ? current / max : 0;
  
  if (percentage >= 1) return 'Uninjured';
  if (percentage >= 0.75) return 'Lightly Wounded';
  if (percentage >= 0.5) return 'Wounded';
  if (percentage >= 0.25) return 'Badly Wounded';
  if (percentage > 0) return 'Near Death';
  return 'Unconscious';
}

export default combatStateProvider;
