/**
 * Embedding model handlers for Ollama.
 */

import type { TextEmbeddingParams, IAgentRuntime } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { embed } from 'ai';
import { createOllama } from 'ollama-ai-provider';

import { getBaseURL, getEmbeddingModel } from '../utils/config';
import { ensureModelAvailable } from './availability';

/**
 * Handle TEXT_EMBEDDING model generation.
 *
 * @param runtime - The agent runtime
 * @param params - Embedding parameters or text string
 * @returns The embedding vector
 */
export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null
): Promise<number[]> {
  try {
    const baseURL = getBaseURL(runtime);
    const customFetch = runtime.fetch ?? undefined;
    const ollama = createOllama({
      fetch: customFetch,
      baseURL,
    });

    const modelName = getEmbeddingModel(runtime);
    logger.log(`[Ollama] Using TEXT_EMBEDDING model: ${modelName}`);
    await ensureModelAvailable(modelName, baseURL, customFetch);

    const text =
      typeof params === 'string'
        ? params
        : params
          ? (params as TextEmbeddingParams).text || ''
          : '';

    // If no text is provided (e.g., for dimension detection), use a default text
    const embeddingText = text || 'test';

    if (!text) {
      logger.debug('No text provided for embedding, using default text for dimension detection');
    }

    try {
      const embedParams = {
        model: ollama.embedding(modelName),
        value: embeddingText,
      };

      const { embedding } = await embed(embedParams as unknown as Parameters<typeof embed>[0]);
      return embedding;
    } catch (embeddingError) {
      logger.error({ error: embeddingError }, 'Error generating embedding');
      return Array(1536).fill(0);
    }
  } catch (error) {
    logger.error({ error }, 'Error in TEXT_EMBEDDING model');
    // Return a fallback vector rather than crashing
    return Array(1536).fill(0);
  }
}
