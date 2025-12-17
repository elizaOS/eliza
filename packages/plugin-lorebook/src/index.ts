import type { Plugin, IAgentRuntime, LoreEntry } from '@elizaos/core';
import { LoreService } from './services';
import { loreProvider } from './providers';
import { characterLoreSchema } from './schemas';

/**
 * Validate lore entry structure
 */
function validateLoreEntry(entry: any, index: number): entry is LoreEntry {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Lore entry at index ${index} is not an object`);
  }

  if (!entry.loreKey || typeof entry.loreKey !== 'string') {
    throw new Error(`Lore entry at index ${index} is missing 'loreKey' or it's not a string`);
  }

  if (!entry.vectorText || typeof entry.vectorText !== 'string') {
    throw new Error(`Lore entry at index ${index} is missing 'vectorText' or it's not a string`);
  }

  if (!entry.content || typeof entry.content !== 'string') {
    throw new Error(`Lore entry at index ${index} is missing 'content' or it's not a string`);
  }

  if (entry.metadata && typeof entry.metadata !== 'object') {
    throw new Error(`Lore entry at index ${index} has invalid 'metadata' (must be an object)`);
  }

  return true;
}

/**
 * Validate character lore configuration
 */
function validateCharacterLore(lore: any): lore is LoreEntry[] {
  if (!Array.isArray(lore)) {
    throw new Error('character.lore must be an array');
  }

  lore.forEach((entry, index) => validateLoreEntry(entry, index));

  return true;
}

/**
 * Character Lore Plugin
 * Provides character-specific knowledge retrieval using RAG (Retrieval-Augmented Generation)
 *
 * Features:
 * - Automatic lore loading from character configuration
 * - Semantic search with vector embeddings
 * - Dynamic embedding dimension support
 * - Smart retrieval strategy (top-K=5, similarity>0.75)
 *
 * Usage:
 * 1. Add lore entries to your character configuration:
 *    ```typescript
 *    {
 *      name: "MyCharacter",
 *      lore: [
 *        {
 *          loreKey: "concept_key",
 *          vectorText: "keywords for search",
 *          content: "The actual knowledge content",
 *          metadata: { optional: "data" }
 *        }
 *      ]
 *    }
 *    ```
 *
 * 2. Add plugin to character plugins:
 *    ```typescript
 *    plugins: ['@elizaos/plugin-lorebook']
 *    ```
 *
 * The lore will be automatically loaded during initialization and made available
 * to the agent through the lore provider for context-aware responses.
 */
export const characterLorePlugin: Plugin = {
  name: '@elizaos/plugin-lorebook',
  description:
    'Character-specific lore management with RAG-based retrieval for contextual knowledge injection',

  schema: characterLoreSchema,

  services: [LoreService],

  providers: [loreProvider],

  async init(config: Record<string, any>, runtime: IAgentRuntime): Promise<void> {
    // Validate character lore if present
    if (runtime.character?.lore) {
      try {
        validateCharacterLore(runtime.character.lore);
        runtime.logger.info(
          `Character lore validation passed: ${runtime.character.lore.length} entries`
        );
      } catch (error) {
        const errorMsg = `Invalid character lore configuration: ${error instanceof Error ? error.message : String(error)}`;
        runtime.logger.error(errorMsg);
        throw new Error(errorMsg);
      }
    } else {
      runtime.logger.info('No character lore configured (character.lore is not set)');
    }

    runtime.logger.info('Character Lore Plugin initialized successfully');
  },
};

export default characterLorePlugin;

// Re-export types for external use
export type { StoredLoreEntry, LoreRetrievalOptions } from './types';
export { LoreService } from './services';
export { loreProvider } from './providers';
