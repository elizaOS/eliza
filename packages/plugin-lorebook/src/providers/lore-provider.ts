import type { IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import { LoreService } from '../services';
import { logger } from '@elizaos/core';

/**
 * Lore Provider
 * Retrieves relevant character lore based on user messages using hybrid search
 *
 * Strategy:
 * - Hybrid Search: Combines semantic (vector) and lexical (BM25) search via RRF fusion
 * - Top-K: 3-5 entries (prevents "Lost in the Middle" phenomenon)
 * - Similarity Threshold: Adaptive (0.75 for short queries, 0.65 for multi-sentence queries)
 *   - Longer queries create "muddier" vectors, requiring a lower threshold
 * - Returns empty if no relevant lore is found (avoids irrelevant context)
 */
export const loreProvider: Provider = {
  name: 'CHARACTER_LORE',
  description:
    'Provides character-specific lore based on message content using hybrid semantic and lexical search',

  async get(runtime: IAgentRuntime, message: Memory, _state?: State) {
    // Get the lore service
    const loreService = runtime.getService<LoreService>('lore');

    if (!loreService) {
      // Service not available, return empty
      return {
        text: '',
        values: {},
        data: {},
      };
    }

    // Fast check: if no lore exists, skip everything (no embedding generation, no search)
    const loreCount = await loreService.getLoreCount();
    if (loreCount === 0) {
      logger.debug('No lore entries available, skipping lore retrieval');
      return {
        text: '',
        values: {
          hasLore: false,
          loreCount: 0,
        },
        data: {
          loreEntries: [],
        },
      };
    }

    // Extract query text from message
    const queryText = message.content?.text || '';

    if (!queryText.trim()) {
      // No text to search with
      return {
        text: '',
        values: {},
        data: {},
      };
    }

    try {
      // Adjust similarity threshold based on query length
      // Longer queries create "muddier" vectors, so we need a lower threshold
      const sentenceCount = queryText.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;
      const similarityThreshold = sentenceCount > 1 ? 0.42 : 0.52;

      // Use hybrid search by default for best results
      // RRF fusion combines semantic understanding with exact keyword matching
      const loreEntries = await loreService.searchLore(queryText, {
        topK: 3, // Max 5 entries to avoid overwhelming the context
        similarityThreshold, // Adaptive threshold based on query length
        includeMetadata: false, // Keep it lean
        fusionStrategy: 'vector', // Default to Reciprocal Rank Fusion
        rrfK: 60, // Standard RRF constant
      });

      if (loreEntries.length === 0) {
        // No relevant lore found - return empty (better than injecting irrelevant context)
        return {
          text: '',
          values: {
            hasLore: false,
            searchStrategy: 'vector',
          },
          data: {
            loreEntries: [],
          },
        };
      }

      // Format lore entries for context injection
      const loreText = formatLoreForContext(loreEntries);

      return {
        text: loreText,
        values: {
          hasLore: true,
          loreCount: loreEntries.length,
          searchStrategy: 'hybrid-rrf',
          characterLore: loreText,
        },
        data: {
          loreEntries: loreEntries.map((entry) => ({
            key: entry.loreKey,
            content: entry.content,
            similarity: entry.similarity,
          })),
        },
      };
    } catch (error) {
      runtime.logger.error('Error in lore provider:', JSON.stringify(error));
      return {
        text: '',
        values: {},
        data: {},
      };
    }
  },
};

/**
 * Format lore entries for context injection
 * Ensures lore is clearly marked and easy for the LLM to parse
 */
function formatLoreForContext(loreEntries: any[]): string {
  if (loreEntries.length === 0) {
    return '';
  }

  const formattedEntries = loreEntries
    .map((entry, index) => {
      const similarityPercent = ((entry.similarity || 0) * 100).toFixed(0);
      return `[Lore ${index + 1}] (Relevance: ${similarityPercent}%)
${entry.content}`;
    })
    .join('\n\n');

  return `  **The Hybrid RAG Protocol:**
  You will have access to "Lore Modules" (Axioms). Treat these as laws of physics. If a user's feeling contradicts the Lore (e.g., "Love should be unconditional"), the Lore wins. You must dismantle the delusion.

  # Lore Modules

${formattedEntries}

---
`;
}
