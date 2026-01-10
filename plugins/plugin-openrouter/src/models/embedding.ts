import type { IAgentRuntime, TextEmbeddingParams } from '@elizaos/core';
import { logger, ModelType, VECTOR_DIMS } from '@elizaos/core';
import { getSetting, getBaseURL, getApiKey, getEmbeddingModel } from '../utils/config';
import { emitModelUsageEvent } from '../utils/events';

/**
 * TEXT_EMBEDDING model handler for OpenRouter
 */
export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null
): Promise<number[]> {
  const embeddingModelName = getEmbeddingModel(runtime);
  const embeddingDimension = Number.parseInt(
    getSetting(runtime, 'OPENROUTER_EMBEDDING_DIMENSIONS') ??
      getSetting(runtime, 'EMBEDDING_DIMENSIONS') ??
      '1536',
    10
  ) as (typeof VECTOR_DIMS)[keyof typeof VECTOR_DIMS];

  if (!Object.values(VECTOR_DIMS).includes(embeddingDimension)) {
    const errorMsg = `Invalid embedding dimension: ${embeddingDimension}. Must be one of: ${Object.values(VECTOR_DIMS).join(', ')}`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  if (params === null) {
    logger.debug('Creating test embedding for initialization');
    const testVector = Array(embeddingDimension).fill(0);
    testVector[0] = 0.1;
    return testVector;
  }

  let text: string;
  if (typeof params === 'string') {
    text = params;
  } else if (typeof params === 'object' && params.text) {
    text = params.text;
  } else {
    const errorMsg = 'Invalid input format for embedding';
    logger.warn(errorMsg);
    const fallbackVector = Array(embeddingDimension).fill(0);
    fallbackVector[0] = 0.2;
    return fallbackVector;
  }

  if (!text.trim()) {
    const errorMsg = 'Empty text for embedding';
    logger.warn(errorMsg);
    const fallbackVector = Array(embeddingDimension).fill(0);
    fallbackVector[0] = 0.3;
    return fallbackVector;
  }

  const apiKey = getApiKey(runtime);
  if (!apiKey) {
    const errorMsg = 'OPENROUTER_API_KEY is not set';
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  const baseURL = getBaseURL(runtime);

  try {
    const response = await fetch(`${baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': getSetting(runtime, 'OPENROUTER_HTTP_REFERER') || '',
        'X-Title': getSetting(runtime, 'OPENROUTER_X_TITLE') || 'ElizaOS',
      },
      body: JSON.stringify({
        model: embeddingModelName,
        input: text,
      }),
    });

    if (!response.ok) {
      logger.error(`OpenRouter API error: ${response.status} - ${response.statusText}`);
      throw new Error(`OpenRouter API error: ${response.status} - ${response.statusText}`);
    }

    const data = (await response.json()) as {
      data: [{ embedding: number[] }];
      usage?: { prompt_tokens: number; total_tokens: number };
    };

    if (!data?.data?.[0]?.embedding) {
      logger.error('API returned invalid structure');
      throw new Error('API returned invalid structure');
    }

    const embedding = data.data[0].embedding;

    if (!Array.isArray(embedding) || embedding.length !== embeddingDimension) {
      const errorMsg = `Embedding length ${embedding?.length ?? 0} does not match configured dimension ${embeddingDimension}`;
      logger.error(errorMsg);
      const fallbackVector = Array(embeddingDimension).fill(0);
      fallbackVector[0] = 0.4;
      return fallbackVector;
    }

    if (data.usage) {
      const usage = {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: 0,
        totalTokens: data.usage.total_tokens,
      };

      emitModelUsageEvent(runtime, ModelType.TEXT_EMBEDDING, text, usage);
    }

    logger.log(`Got valid embedding with length ${embedding.length}`);
    return embedding;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error generating embedding: ${message}`);
    throw error instanceof Error ? error : new Error(message);
  }
}
