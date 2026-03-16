/**
 * Cast Spell Action
 * Handles spellcasting for player characters
 */

import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from '@elizaos/core';
import type { CharacterSheet, Spell } from '../../../types';
import { getAbilityMod } from '../../../types';
import { rollD20, rollDiceArray } from '../../../dice';

export interface CastSpellParams {
  spellName: string;
  targetDescription?: string;
  slotLevel?: number;
  isRitual?: boolean;
}

export const castSpellAction: Action = {
  name: 'CAST_SPELL',
  description: 'Cast a spell from your spell list',
  
  similes: [
    'cast',
    'I cast',
    'use spell',
    'invoke',
    'channel',
  ],
  
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'You see the goblins charging toward you.',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'I raise my hand and speak the words of power. "By the flames of the Weave!" I cast Burning Hands at the charging goblins!',
          action: 'CAST_SPELL',
        },
      },
    ],
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const role = await runtime.getSetting('role');
    if (role !== 'player') return false;
    
    const characterSheet = await runtime.getSetting('characterSheet') as unknown as CharacterSheet | null;
    // Check if character can cast spells
    return Boolean(characterSheet?.spellSlots || characterSheet?.class === 'Warlock');
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ) => {
    const params = (options ?? {}) as unknown as CastSpellParams;
    const characterSheet = await runtime.getSetting('characterSheet') as unknown as CharacterSheet | null;
    
    if (!characterSheet) {
      if (callback) {
        await callback({
          text: 'I cannot cast spells right now.',
          type: 'error',
        });
      }
      return undefined;
    }
    
    // Find the spell in known spells
    const spell = characterSheet.spellsKnown?.find(
      s => s.name.toLowerCase() === params.spellName.toLowerCase()
    );
    
    if (!spell) {
      if (callback) {
        await callback({
          text: `I don't know the spell "${params.spellName}".`,
          type: 'error',
        });
      }
      return undefined;
    }
    
    // Determine spell slot level
    const castLevel = params.slotLevel || spell.level;
    
    // Check cantrips (level 0)
    if (spell.level === 0) {
      await castCantrip(runtime, characterSheet, spell, params.targetDescription, callback);
      return undefined;
    }
    
    // Check ritual casting
    if (params.isRitual && spell.ritual) {
      await castRitual(runtime, characterSheet, spell, params.targetDescription, callback);
      return undefined;
    }
    
    // Check spell slot availability
    if (!characterSheet.spellSlots?.[castLevel] || characterSheet.spellSlots[castLevel].current <= 0) {
      if (callback) {
        await callback({
          text: `I don't have any level ${castLevel} spell slots remaining!`,
          type: 'error',
        });
      }
      return undefined;
    }
    
    // Cast the spell
    await castLeveledSpell(runtime, characterSheet, spell, castLevel, params.targetDescription, callback);
    return undefined;
  },
};

async function castCantrip(
  runtime: IAgentRuntime,
  sheet: CharacterSheet,
  spell: Spell,
  target: string | undefined,
  callback?: HandlerCallback
): Promise<void> {
  const abilityValue = sheet.abilities[getSpellcastingAbility(sheet.class)];
  const abilityMod = getAbilityMod(abilityValue);
  const profBonus = sheet.proficiencyBonus ?? 0;
  const spellDC = 8 + profBonus + abilityMod;
  const spellAttack = profBonus + abilityMod;
  
  let result = generateSpellFlavor(sheet.name, spell);
  
  // Handle attack rolls if applicable
  if (spell.attack) {
    const attackRoll = rollD20();
    const totalAttack = attackRoll + spellAttack;
    result += `\n\n🎲 **Spell Attack:** ${attackRoll} + ${spellAttack} = **${totalAttack}**`;
    
    if (attackRoll === 20) {
      result += ' - **CRITICAL HIT!**';
    } else if (attackRoll === 1) {
      result += ' - **CRITICAL MISS!**';
    }
  }
  
  // Handle damage if applicable
  if (spell.damage) {
    // Scale cantrip damage by level
    const damageScale = getCantripDamageScale(sheet.level);
    const damage = rollDamageFromString(spell.damage, damageScale);
    result += `\n💥 **Damage:** ${damage.total} ${spell.damageType || 'untyped'}`;
  }
  
  // Handle saving throws
  if (spell.savingThrow) {
    result += `\n⚡ **DC ${spellDC} ${spell.savingThrow} save** required`;
  }
  
  if (target) {
    result += `\n*Target: ${target}*`;
  }
  
  if (callback) {
    await callback({
      text: result,
      type: 'spell_cast',
      metadata: {
        characterId: sheet.id,
        characterName: sheet.name,
        spell: spell.name,
        level: 0,
        isCantrip: true,
        target,
      },
    });
  }
  
  runtime.emitEvent?.('spell_cast' as any, {
    characterId: sheet.id,
    characterName: sheet.name,
    spell: spell.name,
    level: 0,
    isCantrip: true,
    timestamp: new Date(),
  });
}

async function castRitual(
  runtime: IAgentRuntime,
  sheet: CharacterSheet,
  spell: Spell,
  target: string | undefined,
  callback?: HandlerCallback
): Promise<void> {
  let result = `*${sheet.name} begins the ritual casting of ${spell.name}...*\n\n`;
  result += `After 10 additional minutes of concentration, the spell takes effect.\n\n`;
  result += generateSpellFlavor(sheet.name, spell);
  
  if (callback) {
    await callback({
      text: result,
      type: 'spell_cast',
      metadata: {
        characterId: sheet.id,
        characterName: sheet.name,
        spell: spell.name,
        level: spell.level,
        isRitual: true,
        target,
      },
    });
  }
}

async function castLeveledSpell(
  runtime: IAgentRuntime,
  sheet: CharacterSheet,
  spell: Spell,
  castLevel: number,
  target: string | undefined,
  callback?: HandlerCallback
): Promise<void> {
  const abilityValue = sheet.abilities[getSpellcastingAbility(sheet.class)];
  const abilityMod = getAbilityMod(abilityValue);
  const profBonus = sheet.proficiencyBonus ?? 0;
  const spellDC = 8 + profBonus + abilityMod;
  const spellAttack = profBonus + abilityMod;
  
  // Deduct spell slot
  if (sheet.spellSlots?.[castLevel]) {
    sheet.spellSlots[castLevel].current -= 1;
    await runtime.setSetting('characterSheet', JSON.stringify(sheet));
  }
  
  let result = generateSpellFlavor(sheet.name, spell);
  
  const upcastBonus = castLevel > spell.level ? ` (upcast to level ${castLevel})` : '';
  result += upcastBonus;
  
  // Handle attack rolls
  if (spell.attack) {
    const attackRoll = rollD20();
    const totalAttack = attackRoll + spellAttack;
    result += `\n\n🎲 **Spell Attack:** ${attackRoll} + ${spellAttack} = **${totalAttack}**`;
    
    if (attackRoll === 20) {
      result += ' - **CRITICAL HIT!**';
    }
  }
  
  // Handle damage with upcasting
  if (spell.damage) {
    const upcastDice = castLevel - spell.level;
    const damage = rollDamageFromString(spell.damage, 1 + upcastDice);
    result += `\n💥 **Damage:** ${damage.total} ${spell.damageType || 'untyped'}`;
  }
  
  // Handle healing
  if (spell.healing) {
    const healing = rollDamageFromString(spell.healing, 1);
    result += `\n💚 **Healing:** ${healing.total} HP`;
  }
  
  // Handle saving throws
  if (spell.savingThrow) {
    result += `\n⚡ **DC ${spellDC} ${spell.savingThrow} save** required`;
  }
  
  // Show remaining slots
  const remaining = sheet.spellSlots?.[castLevel]?.current || 0;
  result += `\n\n*Level ${castLevel} slots remaining: ${remaining}*`;
  
  if (target) {
    result += `\n*Target: ${target}*`;
  }
  
  if (callback) {
    await callback({
      text: result,
      type: 'spell_cast',
      metadata: {
        characterId: sheet.id,
        characterName: sheet.name,
        spell: spell.name,
        level: castLevel,
        target,
        slotsRemaining: remaining,
      },
    });
  }
  
  runtime.emitEvent?.('spell_cast' as any, {
    characterId: sheet.id,
    characterName: sheet.name,
    spell: spell.name,
    level: castLevel,
    timestamp: new Date(),
  });
}

function getSpellcastingAbility(characterClass: string): 'intelligence' | 'wisdom' | 'charisma' {
  const classAbilities: Record<string, 'intelligence' | 'wisdom' | 'charisma'> = {
    Wizard: 'intelligence',
    Cleric: 'wisdom',
    Druid: 'wisdom',
    Ranger: 'wisdom',
    Bard: 'charisma',
    Paladin: 'charisma',
    Sorcerer: 'charisma',
    Warlock: 'charisma',
  };
  
  return classAbilities[characterClass] || 'intelligence';
}

function getCantripDamageScale(level: number): number {
  if (level >= 17) return 4;
  if (level >= 11) return 3;
  if (level >= 5) return 2;
  return 1;
}

function generateSpellFlavor(casterName: string, spell: Spell): string {
  const descriptions: Record<string, string> = {
    'fire bolt': `${casterName} hurls a mote of fire at the target!`,
    'eldritch blast': `Crackling energy springs from ${casterName}'s outstretched hand!`,
    'sacred flame': `A radiant light descends upon the target, called by ${casterName}!`,
    'ray of frost': `${casterName} sends a frigid beam of blue-white light streaking forward!`,
    'magic missile': `${casterName} releases glowing darts of magical force!`,
    'cure wounds': `${casterName}'s hands glow with healing energy!`,
    'healing word': `${casterName} speaks a word of power, mending wounds!`,
    'fireball': `A bright streak flashes from ${casterName}'s finger and blossoms into a massive explosion!`,
    'lightning bolt': `A stroke of lightning forming a line 100 feet long and 5 feet wide blasts out from ${casterName}!`,
    'shield': `An invisible barrier of magical force appears to protect ${casterName}!`,
  };
  
  return descriptions[spell.name.toLowerCase()] || 
    `${casterName} casts ${spell.name}!`;
}

function rollDamageFromString(damageString: string, multiplier: number = 1): { total: number; rolls: number[] } {
  // Parse simple dice strings like "1d10" or "2d6+3"
  const match = damageString.match(/(\d+)d(\d+)(?:\+(\d+))?/);
  if (!match) {
    return { total: 0, rolls: [] };
  }
  
  const numDice = parseInt(match[1]) * multiplier;
  const dieSize = parseInt(match[2]);
  const modifier = parseInt(match[3] || '0');
  
  const rolls = rollDiceArray(numDice, dieSize);
  
  return {
    total: rolls.reduce((a, b) => a + b, 0) + modifier,
    rolls,
  };
}

export default castSpellAction;
