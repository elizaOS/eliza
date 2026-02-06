/**
 * Short Rest Action
 * Handles short rest recovery
 */

import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from '@elizaos/core';
import type { CharacterSheet } from '../../../types';
import { rollDice } from '../../../dice';
import { getHitDieType } from '../../../rules';

export interface ShortRestParams {
  hitDiceToSpend?: number;
}

export const shortRestAction: Action = {
  name: 'SHORT_REST',
  description: 'Take a short rest to recover hit points and some abilities',
  
  similes: [
    'rest',
    'take a break',
    'catch my breath',
    'bandage wounds',
    'short rest',
  ],
  
  examples: [
    [
      {
        user: '{{user1}}',
        content: {
          text: 'The dungeon is quiet. You have time to rest.',
        },
      },
      {
        user: '{{agentName}}',
        content: {
          text: 'I find a defensible corner and sit down heavily, wincing at my wounds. "An hour to tend these injuries would do me good." I spend some hit dice to patch myself up.',
          action: 'SHORT_REST',
        },
      },
    ],
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const role = await runtime.getSetting('role');
    return role === 'player';
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    const params = options as ShortRestParams;
    const characterSheet = await runtime.getSetting('characterSheet') as CharacterSheet | null;
    
    if (!characterSheet) {
      if (callback) {
        await callback({
          text: 'I cannot rest right now.',
          type: 'error',
        });
      }
      return false;
    }
    
    // Check if character needs healing
    const needsHealing = characterSheet.hp.current < characterSheet.hp.max;
    const hasHitDice = (characterSheet.hitDice?.current || 0) > 0;
    
    if (!needsHealing) {
      if (callback) {
        await callback({
          text: `${characterSheet.name} takes a short rest. Already at full health, they use the time to prepare mentally for what lies ahead.`,
          type: 'rest',
          metadata: {
            characterId: characterSheet.id,
            characterName: characterSheet.name,
            healing: 0,
            hitDiceUsed: 0,
          },
        });
      }
      return true;
    }
    
    if (!hasHitDice) {
      if (callback) {
        await callback({
          text: `${characterSheet.name} rests for an hour, but has no hit dice remaining to spend on recovery. Their wounds remain.`,
          type: 'rest',
          metadata: {
            characterId: characterSheet.id,
            characterName: characterSheet.name,
            healing: 0,
            hitDiceUsed: 0,
          },
        });
      }
      return true;
    }
    
    // Calculate how many hit dice to spend
    const hpNeeded = characterSheet.hp.max - characterSheet.hp.current;
    const hitDieSize = getHitDieType(characterSheet.class);
    const conMod = characterSheet.abilities.constitution.modifier;
    const avgHealPerDie = (hitDieSize / 2) + 0.5 + conMod;
    
    // Spend enough dice to get close to full, or as many as requested
    const availableDice = characterSheet.hitDice?.current || 0;
    const diceNeeded = Math.ceil(hpNeeded / avgHealPerDie);
    const diceToSpend = params.hitDiceToSpend 
      ? Math.min(params.hitDiceToSpend, availableDice)
      : Math.min(diceNeeded, availableDice);
    
    // Roll hit dice
    let totalHealing = 0;
    const rolls: number[] = [];
    
    for (let i = 0; i < diceToSpend; i++) {
      const roll = rollDice(1, hitDieSize);
      const healingFromDie = Math.max(1, roll + conMod); // Minimum 1 HP per die
      rolls.push(roll);
      totalHealing += healingFromDie;
    }
    
    // Apply healing
    const newHp = Math.min(characterSheet.hp.max, characterSheet.hp.current + totalHealing);
    const actualHealing = newHp - characterSheet.hp.current;
    
    // Update character sheet
    characterSheet.hp.current = newHp;
    if (characterSheet.hitDice) {
      characterSheet.hitDice.current -= diceToSpend;
    }
    await runtime.setSetting('characterSheet', characterSheet);
    
    // Generate flavor text
    const rollsText = rolls.map(r => `${r}+${conMod}`).join(', ');
    let flavorText = `${characterSheet.name} spends an hour tending to their wounds...`;
    
    if (totalHealing > hpNeeded * 0.75) {
      flavorText = `${characterSheet.name} skillfully bandages their wounds during the rest...`;
    } else if (totalHealing < hpNeeded * 0.25) {
      flavorText = `${characterSheet.name} does what they can, but the wounds are stubborn...`;
    }
    
    const response = `${flavorText}\n\n🎲 **Hit Dice Spent:** ${diceToSpend}d${hitDieSize} (${rollsText})\n💚 **HP Restored:** ${actualHealing} (${characterSheet.hp.current}/${characterSheet.hp.max})\n*Hit Dice Remaining: ${characterSheet.hitDice?.current || 0}/${characterSheet.hitDice?.max || 0}*`;
    
    if (callback) {
      await callback({
        text: response,
        type: 'rest',
        metadata: {
          characterId: characterSheet.id,
          characterName: characterSheet.name,
          healing: actualHealing,
          hitDiceUsed: diceToSpend,
          hitDiceRemaining: characterSheet.hitDice?.current || 0,
          newHp: characterSheet.hp.current,
        },
      });
    }
    
    await runtime.emit('short_rest', {
      characterId: characterSheet.id,
      characterName: characterSheet.name,
      healing: actualHealing,
      hitDiceUsed: diceToSpend,
      timestamp: new Date(),
    });
    
    return true;
  },
};

export default shortRestAction;
