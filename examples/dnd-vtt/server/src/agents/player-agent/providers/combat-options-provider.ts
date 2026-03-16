/**
 * Combat Options Provider
 * Provides available combat actions and tactical information
 */

import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import type { CharacterSheet, Spell, EquipmentSet } from '../../../types';
import { getHP } from '../../../types';

export const combatOptionsProvider: Provider = {
  name: 'combatOptions',
  description: 'Provides available combat actions and tactical options',
  
  get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const combatState = await runtime.getSetting('combatState') as {
      isActive: boolean;
      currentCombatant?: { id: string };
    } | null;
    
    const characterSheet = await runtime.getSetting('characterSheet') as CharacterSheet | null;
    const characterId = await runtime.getSetting('characterId') as string;
    
    if (!combatState?.isActive) {
      return { text: 'Not currently in combat.' };
    }
    
    if (!characterSheet) {
      return { text: 'Character information unavailable.' };
    }
    
    // Check if it's this character's turn
    const isMyTurn = combatState.currentCombatant?.id === characterId;
    
    let context = `## Combat Options\n\n`;
    
    if (!isMyTurn) {
      context += `*Waiting for your turn...*\n\n`;
      context += `Consider preparing a **reaction** such as:\n`;
      context += `- Opportunity Attack (if enemy leaves your reach)\n`;
      context += `- Shield spell (if you have it)\n`;
      context += `- Counterspell (if you have it)\n`;
      return { text: context };
    }
    
    context += `**It's your turn!**\n\n`;
    
    // Standard Actions
    context += `### Actions\n`;
    context += `- **Attack** - Strike with a weapon\n`;
    
    // Spellcasting options
    if (characterSheet.spellSlots || characterSheet.class === 'Warlock') {
      context += `- **Cast a Spell** - Use one of your known spells\n`;
      
      // List available spell slots
      if (characterSheet.spellSlots) {
        const availableSlots = Object.entries(characterSheet.spellSlots)
          .filter(([_, slot]) => slot.current > 0)
          .map(([level, slot]) => `L${level}: ${slot.current}`)
          .join(', ');
        
        if (availableSlots) {
          context += `  *Available slots: ${availableSlots}*\n`;
        }
      }
      
      // List combat-relevant spells
      const combatSpells = characterSheet.spellsKnown?.filter(s => 
        s.level === 0 || // Cantrips
        s.damage || 
        s.savingThrow ||
        s.name.toLowerCase().includes('shield') ||
        s.name.toLowerCase().includes('heal')
      );
      
      if (combatSpells && combatSpells.length > 0) {
        context += `  *Combat spells: ${combatSpells.slice(0, 5).map(s => s.name).join(', ')}*\n`;
      }
    }
    
    context += `- **Dash** - Double your movement speed\n`;
    context += `- **Disengage** - Move without provoking opportunity attacks\n`;
    context += `- **Dodge** - Attackers have disadvantage against you\n`;
    context += `- **Help** - Give an ally advantage\n`;
    context += `- **Hide** - Attempt to become hidden (if concealment available)\n`;
    context += `- **Ready** - Prepare an action for a trigger\n`;
    context += `- **Use Object** - Use an item or interact with environment\n`;
    context += `- **Grapple/Shove** - Special melee attack to grab or push\n`;
    
    // Class-specific actions
    const classActions = getClassActions(characterSheet.class);
    if (classActions.length > 0) {
      context += `\n### Class Features\n`;
      for (const action of classActions) {
        context += `- ${action}\n`;
      }
    }
    
    // Bonus Actions
    context += `\n### Bonus Actions\n`;
    const bonusActions = getBonusActions(characterSheet);
    if (bonusActions.length > 0) {
      for (const action of bonusActions) {
        context += `- ${action}\n`;
      }
    } else {
      context += `*No bonus actions available*\n`;
    }
    
    // Movement
    context += `\n### Movement\n`;
    context += `**Speed:** ${characterSheet.speed}ft\n`;
    context += `- Move to engage enemies or reposition\n`;
    context += `- Take cover for AC bonus\n`;
    context += `- Retreat if wounded\n`;
    
    // Tactical suggestions based on HP
    const combatHP = getHP(characterSheet);
    const hpPercent = (combatHP.current / combatHP.max) * 100;
    context += `\n### Tactical Notes\n`;
    
    if (hpPercent <= 25) {
      context += `⚠️ **LOW HP** - Consider healing, disengaging, or using defensive options\n`;
    } else if (hpPercent <= 50) {
      context += `⚡ **Wounded** - Balance offense with staying alive\n`;
    } else {
      context += `✓ **Healthy** - Aggressive options are viable\n`;
    }
    
    return { text: context };
  },
};

function getClassActions(characterClass: string): string[] {
  const actions: Record<string, string[]> = {
    Barbarian: ['**Rage** (bonus action) - Advantage on STR, resistance to damage'],
    Bard: ['**Bardic Inspiration** (bonus action) - Grant an inspiration die to ally'],
    Cleric: ['**Turn Undead** - Force undead to flee', '**Channel Divinity** - Use domain power'],
    Fighter: ['**Action Surge** - Take an additional action', '**Second Wind** (bonus action) - Heal yourself'],
    Monk: ['**Flurry of Blows** (1 ki) - Two unarmed strikes as bonus action', '**Patient Defense** (1 ki) - Dodge as bonus action'],
    Paladin: ['**Divine Smite** - Add radiant damage on hit', '**Lay on Hands** - Heal with touch'],
    Ranger: ['**Hunter\'s Mark** (bonus action) - Extra damage on marked target'],
    Rogue: ['**Sneak Attack** - Extra damage when you have advantage', '**Cunning Action** (bonus action) - Dash, Disengage, or Hide'],
    Sorcerer: ['**Metamagic** - Modify your spells'],
    Warlock: ['**Eldritch Blast** - Reliable force damage cantrip'],
    Wizard: ['**Arcane Recovery** - Recover spell slots on short rest'],
  };
  
  return actions[characterClass] || [];
}

function getBonusActions(sheet: CharacterSheet): string[] {
  const bonusActions: string[] = [];
  
  // Class-based bonus actions
  switch (sheet.class) {
    case 'Rogue':
      bonusActions.push('**Cunning Action** - Dash, Disengage, or Hide');
      break;
    case 'Monk':
      bonusActions.push('**Martial Arts** - Unarmed strike after Attack action');
      break;
    case 'Barbarian':
      bonusActions.push('**Rage** - Enter rage (if not already raging)');
      break;
    case 'Fighter':
      bonusActions.push('**Second Wind** - Regain 1d10 + level HP');
      break;
  }
  
  // Check for bonus action spells
  const bonusSpells = sheet.spellsKnown?.filter(s => 
    s.castingTime?.toLowerCase().includes('bonus')
  );
  
  if (bonusSpells && bonusSpells.length > 0) {
    for (const spell of bonusSpells.slice(0, 3)) {
      bonusActions.push(`**${spell.name}** - Bonus action spell`);
    }
  }
  
  // Two-weapon fighting
  const equipData = sheet.equipment;
  if (equipData && !Array.isArray(equipData)) {
    const equipSet = equipData as EquipmentSet;
    if (equipSet.weapons && equipSet.weapons.length >= 2) {
      const lightWeapons = equipSet.weapons.filter(w => 
        Array.isArray(w.properties) && w.properties.includes('light')
      );
      if (lightWeapons.length >= 2) {
        bonusActions.push('**Two-Weapon Fighting** - Attack with off-hand weapon');
      }
    }
  }
  
  return bonusActions;
}

export default combatOptionsProvider;
