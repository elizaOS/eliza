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
import { getHP, getAbilityMod } from '../../../types';
import { rollDie } from '../../../dice';
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
        name: '{{user1}}',
        content: {
          text: 'The dungeon is quiet. You have time to rest.',
        },
      },
      {
        name: '{{agentName}}',
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
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ) => {
    const params = (options ?? {}) as ShortRestParams;
    const characterSheet = await runtime.getSetting('characterSheet') as unknown as CharacterSheet | null;
    
    if (!characterSheet) {
      if (callback) {
        await callback({
          text: 'I cannot rest right now.',
          type: 'error',
        });
      }
      return undefined;
    }
    
    // Check if character needs healing
    const hp = getHP(characterSheet);
    const needsHealing = hp.current < hp.max;
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
      return undefined;
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
      return undefined;
    }
    
    // Calculate how many hit dice to spend
    const hpNeeded = hp.max - hp.current;
    const hitDieType = getHitDieType(characterSheet.class);
    const hitDieSize = parseInt(hitDieType.slice(1));
    const conMod = getAbilityMod(characterSheet.abilities.constitution);
    const avgHealPerDie = (hitDieSize / 2) + 0.5 + conMod;
    
    // Spend enough dice to get close to full, or as many as requested
    const availableDice = characterSheet.hitDice?.current || 0;
    const diceNeeded = Math.ceil(hpNeeded / Math.max(1, avgHealPerDie));
    const diceToSpend = params.hitDiceToSpend 
      ? Math.min(params.hitDiceToSpend, availableDice)
      : Math.min(diceNeeded, availableDice);
    
    // Roll hit dice
    let totalHealing = 0;
    const rolls: number[] = [];
    
    for (let i = 0; i < diceToSpend; i++) {
      const roll = rollDie(hitDieType);
      const healingFromDie = Math.max(1, roll + conMod); // Minimum 1 HP per die
      rolls.push(roll);
      totalHealing += healingFromDie;
    }
    
    // Apply healing
    const newHp = Math.min(hp.max, hp.current + totalHealing);
    const actualHealing = newHp - hp.current;
    
    // Update character sheet
    if (characterSheet.hp) {
      characterSheet.hp.current = newHp;
    } else if (characterSheet.hitPoints) {
      characterSheet.hitPoints.current = newHp;
    }
    if (characterSheet.hitDice) {
      characterSheet.hitDice.current -= diceToSpend;
    }
    await runtime.setSetting('characterSheet', JSON.stringify(characterSheet));
    
    // Generate flavor text
    const rollsText = rolls.map(r => `${r}+${conMod}`).join(', ');
    let flavorText = `${characterSheet.name} spends an hour tending to their wounds...`;
    
    if (totalHealing > hpNeeded * 0.75) {
      flavorText = `${characterSheet.name} skillfully bandages their wounds during the rest...`;
    } else if (totalHealing < hpNeeded * 0.25) {
      flavorText = `${characterSheet.name} does what they can, but the wounds are stubborn...`;
    }
    
    const response = `${flavorText}\n\n🎲 **Hit Dice Spent:** ${diceToSpend}${hitDieType} (${rollsText})\n💚 **HP Restored:** ${actualHealing} (${newHp}/${hp.max})\n*Hit Dice Remaining: ${characterSheet.hitDice?.current || 0}/${characterSheet.hitDice?.max || 0}*`;
    
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
          newHp,
        },
      });
    }
    
    runtime.emitEvent?.('short_rest' as any, {
      characterId: characterSheet.id,
      characterName: characterSheet.name,
      healing: actualHealing,
      hitDiceUsed: diceToSpend,
      timestamp: new Date(),
    });
    
    return undefined;
  },
};

export default shortRestAction;
