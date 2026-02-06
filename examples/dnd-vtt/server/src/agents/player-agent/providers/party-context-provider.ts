/**
 * Party Context Provider
 * Provides information about party members and dynamics
 */

import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import type { CharacterSheet } from '../../../types';
import { getHP } from '../../../types';
import { characterRepository } from '../../../persistence';

export const partyContextProvider: Provider = {
  name: 'partyContext',
  description: 'Provides information about other party members',
  
  get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const campaignId = await runtime.getSetting('campaignId') as string;
    const myCharacterId = await runtime.getSetting('characterId') as string;
    
    if (!campaignId) {
      return { text: 'No party information available.' };
    }
    
    try {
      const allCharacters = await characterRepository.getByCampaign(campaignId);
      const partyMembers = allCharacters.filter(c => c.id !== myCharacterId);
      
      if (partyMembers.length === 0) {
        return { text: 'You are traveling alone.' };
      }
      
      let context = `## Party Members\n\n`;
      
      for (const member of partyMembers) {
        context += formatPartyMember(member);
        context += '\n';
      }
      
      // Party composition summary
      context += `### Party Composition\n`;
      const roles = analyzePartyRoles(partyMembers);
      context += `- **Frontline:** ${roles.frontline.join(', ') || 'None'}\n`;
      context += `- **Support:** ${roles.support.join(', ') || 'None'}\n`;
      context += `- **Damage:** ${roles.damage.join(', ') || 'None'}\n`;
      
      // Party health overview
      const totalHp = partyMembers.reduce((sum, m) => sum + getHP(m).current, 0);
      const maxHp = partyMembers.reduce((sum, m) => sum + getHP(m).max, 0);
      const healthPercent = Math.round((totalHp / maxHp) * 100);
      context += `\n**Party Health:** ${healthPercent}%\n`;
      
      return { text: context };
      
    } catch (error) {
      console.error('Error fetching party context:', error);
      return { text: 'Error loading party information.' };
    }
  },
};

function formatPartyMember(member: CharacterSheet): string {
  const hp = getHP(member);
  const hpPercent = Math.round((hp.current / hp.max) * 100);
  const healthStatus = hpPercent >= 75 ? '🟢' 
    : hpPercent >= 50 ? '🟡'
    : hpPercent >= 25 ? '🟠'
    : '🔴';
  
  let status = `### ${member.name}\n`;
  status += `**${member.race} ${member.class} ${member.level}**\n`;
  status += `${healthStatus} HP: ${hp.current}/${hp.max}\n`;
  
  // Show conditions if any
  if (member.conditions && member.conditions.length > 0) {
    status += `⚠️ ${member.conditions.map(c => c.name).join(', ')}\n`;
  }
  
  return status;
}

function analyzePartyRoles(members: CharacterSheet[]): {
  frontline: string[];
  support: string[];
  damage: string[];
} {
  const frontline: string[] = [];
  const support: string[] = [];
  const damage: string[] = [];
  
  const frontlineClasses = ['Fighter', 'Barbarian', 'Paladin'];
  const supportClasses = ['Cleric', 'Bard', 'Druid'];
  const damageClasses = ['Rogue', 'Wizard', 'Sorcerer', 'Warlock'];
  
  for (const member of members) {
    if (frontlineClasses.includes(member.class)) {
      frontline.push(member.name);
    }
    if (supportClasses.includes(member.class)) {
      support.push(member.name);
    }
    if (damageClasses.includes(member.class)) {
      damage.push(member.name);
    }
    // Ranger and Monk could fill multiple roles
    if (member.class === 'Ranger') {
      damage.push(member.name);
    }
    if (member.class === 'Monk') {
      frontline.push(member.name);
    }
  }
  
  return { frontline, support, damage };
}

export default partyContextProvider;
