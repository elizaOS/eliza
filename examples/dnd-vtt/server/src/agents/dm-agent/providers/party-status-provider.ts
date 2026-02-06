/**
 * Party Status Provider
 * Provides current status of all player characters
 */

import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import type { CharacterSheet, HitPoints, EquipmentSet } from '../../../types';
import { getHP, getAC, getAbilityMod } from '../../../types';
import { characterRepository } from '../../../persistence';

export const partyStatusProvider: Provider = {
  name: 'partyStatus',
  description: 'Provides current status of all player characters',
  
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const campaignId = runtime.getSetting('campaignId') as string;
    
    if (!campaignId) {
      return { text: 'No active campaign.' };
    }
    
    try {
      // Get all characters in the campaign
      const characters = await characterRepository.getByCampaign(campaignId);
      
      if (characters.length === 0) {
        return { text: 'No characters in the party.' };
      }
      
      let context = `## Party Status\n\n`;
      
      // Party composition summary
      const classes = characters.map(c => c.class);
      const avgLevel = Math.round(characters.reduce((sum, c) => sum + c.level, 0) / characters.length);
      context += `**Composition:** ${classes.join(', ')}\n`;
      context += `**Party Size:** ${characters.length}\n`;
      context += `**Average Level:** ${avgLevel}\n\n`;
      
      // Resource status
      const totalHp = characters.reduce((sum, c) => sum + getHP(c).current, 0);
      const maxHp = characters.reduce((sum, c) => sum + getHP(c).max, 0);
      const hpPercentage = maxHp > 0 ? Math.round((totalHp / maxHp) * 100) : 100;
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
        const equip = c.equipment;
        // equipment can be Item[] or EquipmentSet
        if (equip && !Array.isArray(equip)) {
          const equipSet = equip as EquipmentSet;
          return sum + (equipSet.currency?.gp ?? equipSet.currency?.gold ?? 0);
        }
        // Also check top-level currency
        return sum + (c.currency?.gp ?? c.currency?.gold ?? 0);
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
      
      return { text: context };
      
    } catch (error) {
      console.error('Error fetching party status:', error);
      return { text: 'Error loading party status.' };
    }
  },
};

function formatCharacterStatus(character: CharacterSheet): string {
  const hp = getHP(character);
  const ac = getAC(character);
  
  let status = `#### ${character.name}\n`;
  status += `**${character.race} ${character.class} ${character.level}**`;
  
  if (character.subclass) {
    status += ` (${character.subclass})`;
  }
  
  status += '\n';
  
  // Health
  const hpPercent = hp.max > 0 ? Math.round((hp.current / hp.max) * 100) : 100;
  const hpBar = getHealthBar(hpPercent);
  status += `HP: ${hp.current}/${hp.max} ${hpBar}`;
  
  if ((hp.temporary ?? 0) > 0) {
    status += ` (+${hp.temporary} temp)`;
  }
  status += '\n';
  
  // Active conditions
  if (character.conditions && character.conditions.length > 0) {
    const conditionNames = character.conditions.map(c => c.condition ?? c.name ?? 'unknown');
    status += `**Conditions:** ${conditionNames.join(', ')}\n`;
  }
  
  // Key stats for DM reference
  const dexMod = getAbilityMod(character.abilities.dexterity);
  const wisMod = getAbilityMod(character.abilities.wisdom);
  const passivePerception = 10 + (character.skills?.perception ?? wisMod);
  
  status += `AC: ${ac} | `;
  status += `Init: ${dexMod >= 0 ? '+' : ''}${dexMod} | `;
  status += `Speed: ${character.speed ?? 30}ft | `;
  status += `PP: ${passivePerception}\n`;
  
  return status;
}

function getHealthBar(percentage: number): string {
  const filled = Math.round(percentage / 10);
  const empty = 10 - filled;
  
  let color: string;
  if (percentage >= 75) color = '\u{1F7E9}';
  else if (percentage >= 50) color = '\u{1F7E8}';
  else if (percentage >= 25) color = '\u{1F7E7}';
  else color = '\u{1F7E5}';
  
  return color.repeat(filled) + '\u{2B1C}'.repeat(empty);
}

export default partyStatusProvider;
