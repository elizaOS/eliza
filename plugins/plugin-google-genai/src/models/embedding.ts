import type { IAgentRuntime, TextEmbeddingParams } from '@elizaos/core';
import { logger, ModelType } from '@elizaos/core';
import { createGoogleGenAI, getEmbeddingModel } from '../utils/config';
import { emitModelUsageEvent } from '../utils/events';
import { countTokens } from '../utils/tokenization';

export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null
): Promise<number[]> {
  const genAI = createGoogleGenAI(runtime);
  if (!genAI) {
    throw new Error('Google Generative AI client not initialized');
  }

  const embeddingModelName = getEmbeddingModel(runtime);
  logger.debug(`[TEXT_EMBEDDING] Using model: ${embeddingModelName}`);

  // Handle null case for initialization
  if (params === null) {
    logger.debug('Creating test embedding for initialization');
    // Return 768-dimensional vector for text-embedding-004
    const dimension = 768;
    const testVector = Array(dimension).fill(0);
    testVector[0] = 0.1;
    return testVector;
  }

  // Extract text from params
  let text: string;
  if (typeof params === 'string') {
    text = params;
  } else if (typeof params === 'object' && params.text) {
    text = params.text;
  } else {
    logger.warn('Invalid input format for embedding');
    const dimension = 768;
    const fallbackVector = Array(dimension).fill(0);
    fallbackVector[0] = 0.2;
    return fallbackVector;
  }

  if (!text.trim()) {
    logger.warn('Empty text for embedding');
    const dimension = 768;
    const emptyVector = Array(dimension).fill(0);
    emptyVector[0] = 0.3;
    return emptyVector;
  }

  try {
    const response = await genAI.models.embedContent({
      model: embeddingModelName,
      contents: text,
    });

    const embedding = response.embeddings?.[0]?.values || [];

    // Count tokens for usage tracking
    const promptTokens = await countTokens(text);

    emitModelUsageEvent(runtime, ModelType.TEXT_EMBEDDING, text, {
      promptTokens,
      completionTokens: 0,
      totalTokens: promptTokens,
    });

    logger.log(`Got embedding with length ${embedding.length}`);
    return embedding;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error generating embedding: ${message}`);
    // Return error vector
    const dimension = 768;
    const errorVector = Array(dimension).fill(0);
    errorVector[0] = 0.6;
    return errorVector;
  }
}
