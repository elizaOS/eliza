/**
 * Party Status Provider
 * Provides current status of all player characters
 */

import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import type { CharacterSheet } from '../../../types';
import { characterRepository } from '../../../persistence';

export const partyStatusProvider: Provider = {
  name: 'partyStatus',
  description: 'Provides current status of all player characters',
  
  get: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<string> => {
    const campaignId = await runtime.getSetting('campaignId') as string;
    
    if (!campaignId) {
      return 'No active campaign.';
    }
    
    try {
      // Get all characters in the campaign
      const characters = await characterRepository.getByCampaign(campaignId);
      
      if (characters.length === 0) {
        return 'No characters in the party.';
      }
      
      let context = `## Party Status\n\n`;
      
      // Party composition summary
      const classes = characters.map(c => c.class);
      const avgLevel = Math.round(characters.reduce((sum, c) => sum + c.level, 0) / characters.length);
      context += `**Composition:** ${classes.join(', ')}\n`;
      context += `**Party Size:** ${characters.length}\n`;
      context += `**Average Level:** ${avgLevel}\n\n`;
      
      // Resource status
      const totalHp = characters.reduce((sum, c) => sum + c.hp.current, 0);
      const maxHp = characters.reduce((sum, c) => sum + c.hp.max, 0);
      const hpPercentage = Math.round((totalHp / maxHp) * 100);
      context += `**Party Health:** ${hpPercentage}% (${totalHp}/${maxHp} HP)\n\n`;
      
      // Individual character details
      context += '### Characters\n\n';
      
      for (const character of characters) {
        context += formatCharacterStatus(character);
        context += '\n';
      }
      
      // Party resources summary
      context += '### Party Resources\n';
      const totalGold = characters.reduce((sum, c) => {
        const gold = c.equipment.currency?.gp || 0;
        return sum + gold;
      }, 0);
      context += `**Combined Gold:** ${totalGold} gp\n`;
      
      // Spell slots remaining (for casters)
      const casters = characters.filter(c => c.spellSlots && Object.keys(c.spellSlots).length > 0);
      if (casters.length > 0) {
        context += `\n**Spellcasters:**\n`;
        for (const caster of casters) {
          const slots = Object.entries(caster.spellSlots || {})
            .filter(([_, slot]) => slot.max > 0)
            .map(([level, slot]) => `L${level}: ${slot.current}/${slot.max}`)
            .join(', ');
          context += `- ${caster.name}: ${slots}\n`;
        }
      }
      
      return context;
      
    } catch (error) {
      console.error('Error fetching party status:', error);
      return 'Error loading party status.';
    }
  },
};

function formatCharacterStatus(character: CharacterSheet): string {
  let status = `#### ${character.name}\n`;
  status += `**${character.race} ${character.class} ${character.level}**`;
  
  if (character.subclass) {
    status += ` (${character.subclass})`;
  }
  
  status += '\n';
  
  // Health
  const hpPercent = Math.round((character.hp.current / character.hp.max) * 100);
  const hpBar = getHealthBar(hpPercent);
  status += `HP: ${character.hp.current}/${character.hp.max} ${hpBar}`;
  
  if (character.hp.temp > 0) {
    status += ` (+${character.hp.temp} temp)`;
  }
  status += '\n';
  
  // Active conditions
  if (character.conditions && character.conditions.length > 0) {
    const conditionNames = character.conditions.map(c => c.name);
    status += `**Conditions:** ${conditionNames.join(', ')}\n`;
  }
  
  // Key stats for DM reference
  status += `AC: ${character.ac} | `;
  status += `Init: ${character.abilities.dexterity.modifier >= 0 ? '+' : ''}${character.abilities.dexterity.modifier} | `;
  status += `Speed: ${character.speed}ft | `;
  status += `PP: ${10 + (character.skills?.perception || character.abilities.wisdom.modifier)}\n`;
  
  return status;
}

function getHealthBar(percentage: number): string {
  const filled = Math.round(percentage / 10);
  const empty = 10 - filled;
  
  let color: string;
  if (percentage >= 75) color = '🟩';
  else if (percentage >= 50) color = '🟨';
  else if (percentage >= 25) color = '🟧';
  else color = '🟥';
  
  return color.repeat(filled) + '⬜'.repeat(empty);
}

export default partyStatusProvider;
