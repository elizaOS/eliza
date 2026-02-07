/**
 * Character Sheet Provider
 * Provides character stats and abilities to the player agent
 */

import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import type { CharacterSheet, EquipmentSet } from '../../../types';
import { getHP, getAC, getAbilityMod, getAbilityScore, getConditionName } from '../../../types';

export const characterSheetProvider: Provider = {
  name: 'characterSheet',
  description: 'Provides the player character\'s stats and abilities',
  
  get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const sheet = await runtime.getSetting('characterSheet') as CharacterSheet | null;
    
    if (!sheet) {
      return { text: 'Character information unavailable.' };
    }
    
    let context = `## ${sheet.name}\n`;
    context += `**${sheet.race} ${sheet.class} ${sheet.level}**`;
    if (sheet.subclass) {
      context += ` (${sheet.subclass})`;
    }
    context += '\n\n';
    
    // HP Status
    const hp = getHP(sheet);
    const hpPercent = Math.round((hp.current / hp.max) * 100);
    context += `### Health\n`;
    context += `**HP:** ${hp.current}/${hp.max} (${hpPercent}%)`;
    if ((hp.temporary ?? 0) > 0) {
      context += ` [+${hp.temporary} temp]`;
    }
    context += '\n';
    context += `**AC:** ${getAC(sheet)}\n`;
    context += `**Speed:** ${sheet.speed}ft\n\n`;
    
    // Ability Scores
    context += `### Abilities\n`;
    const abilities = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'] as const;
    for (const ability of abilities) {
      const mod = getAbilityMod(sheet.abilities[ability]);
      const score = getAbilityScore(sheet.abilities[ability]);
      const sign = mod >= 0 ? '+' : '';
      context += `**${ability.substring(0, 3).toUpperCase()}:** ${score} (${sign}${mod})\n`;
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
      context += sheet.conditions.map(c => `⚠️ ${getConditionName(c)}`).join(', ');
      context += '\n\n';
    }
    
    // Equipment highlights
    context += `### Equipment\n`;
    const equip = sheet.equipment;
    if (equip && !Array.isArray(equip)) {
      const equipSet = equip as EquipmentSet;
      if (equipSet.weapons?.length) {
        context += `**Weapons:** ${equipSet.weapons.map(w => w.name).join(', ')}\n`;
      }
      if (equipSet.armor) {
        context += `**Armor:** ${equipSet.armor.name}\n`;
      }
      
      // Currency
      const currency = equipSet.currency ?? sheet.currency;
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
    } else if (Array.isArray(equip) && equip.length > 0) {
      context += equip.map(item => `${item.name}${item.equipped ? ' (equipped)' : ''}`).join(', ') + '\n';
    }
    
    return { text: context };
  },
};

export default characterSheetProvider;
