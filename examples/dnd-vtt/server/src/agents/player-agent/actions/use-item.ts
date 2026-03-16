/**
 * Use Item Action
 * Handles using items from inventory
 */

import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from '@elizaos/core';
import type { CharacterSheet, InventoryItem } from '../../../types';
import { rollDie } from '../../../dice';

export interface UseItemParams {
  itemName: string;
  target?: string;
}

export const useItemAction: Action = {
  name: 'USE_ITEM',
  description: 'Use an item from your inventory',
  
  similes: [
    'use',
    'drink',
    'eat',
    'apply',
    'pull out',
    'activate',
  ],
  
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'You are badly wounded after the battle.',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'I reach into my pack with trembling hands and pull out a healing potion. "This should help..." I uncork it and drink deeply.',
          action: 'USE_ITEM',
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
    const params = (options ?? {}) as unknown as UseItemParams;
    const characterSheet = await runtime.getSetting('characterSheet') as unknown as CharacterSheet | null;
    
    if (!characterSheet) {
      if (callback) {
        await callback({
          text: 'I seem to have misplaced my belongings...',
          type: 'error',
        });
      }
      return undefined;
    }
    
    // Find the item in inventory
    const item = findItem(characterSheet, params.itemName);
    
    if (!item) {
      if (callback) {
        await callback({
          text: `I don't have "${params.itemName}" in my inventory.`,
          type: 'error',
        });
      }
      return undefined;
    }
    
    // Process item use
    const result = processItemUse(characterSheet.name, item, params.target);
    
    // Remove consumable items
    if (result.consumed) {
      removeItemFromInventory(characterSheet, item);
      await runtime.setSetting('characterSheet', JSON.stringify(characterSheet));
    }
    
    if (callback) {
      await callback({
        text: result.description,
        type: 'item_used',
        metadata: {
          characterId: characterSheet.id,
          characterName: characterSheet.name,
          itemName: item.name,
          itemType: item.type,
          effect: result.effect,
          consumed: result.consumed,
          target: params.target,
        },
      });
    }
    
    runtime.emitEvent?.('item_used' as any, {
      characterId: characterSheet.id,
      characterName: characterSheet.name,
      itemName: item.name,
      effect: result.effect,
      timestamp: new Date(),
    });
    
    return undefined;
  },
};

function getInventoryItems(sheet: CharacterSheet): InventoryItem[] {
  if (!sheet.equipment) return [];
  if (Array.isArray(sheet.equipment)) return sheet.equipment;
  return sheet.equipment.inventory ?? [];
}

function findItem(sheet: CharacterSheet, itemName: string): InventoryItem | undefined {
  const lowerName = itemName.toLowerCase();
  const items = getInventoryItems(sheet);
  return items.find(i => i.name.toLowerCase().includes(lowerName));
}

function removeItemFromInventory(sheet: CharacterSheet, item: InventoryItem): void {
  const items = getInventoryItems(sheet);
  const index = items.findIndex(i => i.name === item.name);
  if (index >= 0) {
    const qty = items[index].quantity;
    if (qty !== undefined && qty > 1) {
      items[index].quantity = qty - 1;
    } else {
      items.splice(index, 1);
    }
  }
}

interface ItemUseResult {
  description: string;
  effect?: string;
  consumed: boolean;
  healing?: number;
  damage?: number;
}

function processItemUse(characterName: string, item: InventoryItem, target?: string): ItemUseResult {
  const itemLower = item.name.toLowerCase();
  
  // Healing potions
  if (itemLower.includes('healing')) {
    return processHealingPotion(characterName, item);
  }
  
  // Other potions
  if (itemLower.includes('potion')) {
    return processGenericPotion(characterName, item);
  }
  
  // Scrolls
  if (itemLower.includes('scroll')) {
    return processScroll(characterName, item);
  }
  
  // Tools
  if (item.type === 'tool' || item.type === 'gear') {
    return {
      description: `${characterName} uses the ${item.name}.`,
      consumed: false,
    };
  }
  
  // Default
  return {
    description: `${characterName} uses ${item.name}.${target ? ` (targeting ${target})` : ''}`,
    consumed: item.type === 'consumable',
  };
}

function processHealingPotion(characterName: string, item: InventoryItem): ItemUseResult {
  const itemLower = item.name.toLowerCase();
  
  let healing = 0;
  let diceDescription = '';
  
  if (itemLower.includes('superior')) {
    const rolls = Array.from({ length: 8 }, () => rollDie('d4'));
    healing = rolls.reduce((a, b) => a + b, 0) + 8;
    diceDescription = '8d4+8';
  } else if (itemLower.includes('greater')) {
    const rolls = Array.from({ length: 4 }, () => rollDie('d4'));
    healing = rolls.reduce((a, b) => a + b, 0) + 4;
    diceDescription = '4d4+4';
  } else if (itemLower.includes('supreme')) {
    const rolls = Array.from({ length: 10 }, () => rollDie('d4'));
    healing = rolls.reduce((a, b) => a + b, 0) + 20;
    diceDescription = '10d4+20';
  } else {
    // Standard healing potion
    const rolls = Array.from({ length: 2 }, () => rollDie('d4'));
    healing = rolls.reduce((a, b) => a + b, 0) + 2;
    diceDescription = '2d4+2';
  }
  
  return {
    description: `${characterName} drinks the ${item.name}, feeling warmth spread through their body.\n\n💚 **Healing:** ${diceDescription} = **${healing} HP restored!**`,
    effect: `heal_${healing}`,
    consumed: true,
    healing,
  };
}

function processGenericPotion(characterName: string, item: InventoryItem): ItemUseResult {
  const itemLower = item.name.toLowerCase();
  let effect = '';
  
  if (itemLower.includes('speed')) {
    effect = 'Haste effect for 1 minute';
  } else if (itemLower.includes('invisibility')) {
    effect = 'Invisible for 1 hour';
  } else if (itemLower.includes('giant strength')) {
    effect = 'Strength set to 21 for 1 hour';
  } else if (itemLower.includes('resistance')) {
    effect = 'Resistance to one damage type for 1 hour';
  } else {
    effect = 'Magical effect';
  }
  
  return {
    description: `${characterName} drinks the ${item.name}!\n\n✨ **Effect:** ${effect}`,
    effect,
    consumed: true,
  };
}

function processScroll(characterName: string, item: InventoryItem): ItemUseResult {
  // Extract spell name from scroll
  const spellMatch = item.name.match(/scroll of (.+)/i);
  const spellName = spellMatch ? spellMatch[1] : 'unknown magic';
  
  return {
    description: `${characterName} reads from the ${item.name}. The words shimmer and fade as the magic takes effect!\n\n📜 **Spell:** ${spellName}`,
    effect: `cast_${spellName.toLowerCase().replace(/\s+/g, '_')}`,
    consumed: true,
  };
}

export default useItemAction;
