/**
 * Character Sheet Provider
 * Provides character stats and abilities to the player agent
 */

import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import type { CharacterSheet } from '../../../types';

export const characterSheetProvider: Provider = {
  name: 'characterSheet',
  description: 'Provides the player character\'s stats and abilities',
  
  get: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<string> => {
    const sheet = await runtime.getSetting('characterSheet') as CharacterSheet | null;
    
    if (!sheet) {
      return 'Character information unavailable.';
    }
    
    let context = `## ${sheet.name}\n`;
    context += `**${sheet.race} ${sheet.class} ${sheet.level}**`;
    if (sheet.subclass) {
      context += ` (${sheet.subclass})`;
    }
    context += '\n\n';
    
    // HP Status
    const hpPercent = Math.round((sheet.hp.current / sheet.hp.max) * 100);
    context += `### Health\n`;
    context += `**HP:** ${sheet.hp.current}/${sheet.hp.max} (${hpPercent}%)`;
    if (sheet.hp.temp > 0) {
      context += ` [+${sheet.hp.temp} temp]`;
    }
    context += '\n';
    context += `**AC:** ${sheet.ac}\n`;
    context += `**Speed:** ${sheet.speed}ft\n\n`;
    
    // Ability Scores
    context += `### Abilities\n`;
    const abilities = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'] as const;
    for (const ability of abilities) {
      const mod = sheet.abilities[ability].modifier;
      const sign = mod >= 0 ? '+' : '';
      context += `**${ability.substring(0, 3).toUpperCase()}:** ${sheet.abilities[ability].score} (${sign}${mod})\n`;
    }
    context += '\n';
    
    // Key Skills
    if (sheet.skills) {
      context += `### Proficient Skills\n`;
      const proficientSkills = Object.entries(sheet.skills)
        .filter(([_, mod]) => mod !== undefined)
        .map(([skill, mod]) => {
          const sign = mod >= 0 ? '+' : '';
          return `${skill}: ${sign}${mod}`;
        });
      context += proficientSkills.join(', ') + '\n\n';
    }
    
    // Spell Slots (if caster)
    if (sheet.spellSlots) {
      context += `### Spell Slots\n`;
      const slots = Object.entries(sheet.spellSlots)
        .filter(([_, slot]) => slot.max > 0)
        .map(([level, slot]) => `L${level}: ${slot.current}/${slot.max}`);
      context += slots.join(' | ') + '\n\n';
    }
    
    // Hit Dice
    if (sheet.hitDice) {
      context += `**Hit Dice:** ${sheet.hitDice.current}/${sheet.hitDice.max}\n\n`;
    }
    
    // Active Conditions
    if (sheet.conditions && sheet.conditions.length > 0) {
      context += `### Conditions\n`;
      context += sheet.conditions.map(c => `⚠️ ${c.name}`).join(', ');
      context += '\n\n';
    }
    
    // Equipment highlights
    context += `### Equipment\n`;
    if (sheet.equipment.weapons?.length) {
      context += `**Weapons:** ${sheet.equipment.weapons.map(w => w.name).join(', ')}\n`;
    }
    if (sheet.equipment.armor) {
      context += `**Armor:** ${sheet.equipment.armor.name}\n`;
    }
    
    // Currency
    const currency = sheet.equipment.currency;
    if (currency) {
      const coins: string[] = [];
      if (currency.pp) coins.push(`${currency.pp}pp`);
      if (currency.gp) coins.push(`${currency.gp}gp`);
      if (currency.sp) coins.push(`${currency.sp}sp`);
      if (currency.cp) coins.push(`${currency.cp}cp`);
      if (coins.length > 0) {
        context += `**Coin:** ${coins.join(', ')}\n`;
      }
    }
    
    return context;
  },
};

export default characterSheetProvider;
