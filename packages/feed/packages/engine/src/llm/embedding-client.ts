/**
 * Embedding Client
 *
 * Thin wrapper around OpenAI's text-embedding-3-small for semantic similarity.
 * Used by ContentQualityGate (parody validation) and WorldFactsConsolidator
 * (fact clustering). Separate from BabylonLLMClient because embeddings are
 * OpenAI-only — the Groq/Claude fallback chain doesn't apply.
 *
 * Gracefully degrades: returns null when OPENAI_API_KEY is missing, so callers
 * can skip embedding-based checks without crashing the pipeline.
 */

import { logger } from '@babylon/shared';
import OpenAI from 'openai';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const MAX_BATCH_SIZE = 100;

let openaiClient: OpenAI | null = null;
let initialized = false;

/**
 * Lazily initialize the OpenAI-compatible client for embeddings.
 * Prefers ELIZACLOUD_API_KEY, falls back to OPENAI_API_KEY.
 * Returns null if neither key is set.
 */
function getClient(): OpenAI | null {
  if (initialized) return openaiClient;
  initialized = true;

  const elizacloudKey = process.env.ELIZACLOUD_API_KEY;
  if (elizacloudKey) {
    const base =
      process.env.ELIZACLOUD_API_URL?.replace(/\/$/, '') ||
      'https://api.elizacloud.com';
    logger.debug(
      'EmbeddingClient using ElizaCloud',
      { baseURL: `${base}/openai/v1` },
      'EmbeddingClient'
    );
    openaiClient = new OpenAI({
      apiKey: elizacloudKey,
      baseURL: `${base}/openai/v1`,
      timeout: 30_000,
      maxRetries: 2,
    });
    return openaiClient;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn(
      'Neither ELIZACLOUD_API_KEY nor OPENAI_API_KEY set — embedding-based quality checks will be skipped',
      undefined,
      'EmbeddingClient'
    );
    return null;
  }

  openaiClient = new OpenAI({ apiKey, timeout: 30_000, maxRetries: 2 });
  return openaiClient;
}

/**
 * Get the embedding vector for a single text.
 * Returns null if the API key is missing or the call fails.
 */
export async function getEmbedding(text: string): Promise<number[] | null> {
  const client = getClient();
  if (!client) return null;

  const startTime = Date.now();
  try {
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
    });
    const latencyMs = Date.now() - startTime;
    logger.debug(
      'Embedding request completed',
      { latencyMs, textLength: text.length },
      'EmbeddingClient'
    );
    return response.data[0]?.embedding ?? null;
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    logger.error(
      'Embedding request failed',
      {
        error: error instanceof Error ? error.message : String(error),
        latencyMs,
      },
      'EmbeddingClient'
    );
    return null;
  }
}

/**
 * Get embeddings for multiple texts in a single batch call.
 * Returns an array aligned with the input — null entries for failures.
 */
export async function getEmbeddings(
  texts: string[]
): Promise<(number[] | null)[]> {
  const client = getClient();
  if (!client) return texts.map(() => null);

  if (texts.length === 0) return [];

  // OpenAI supports batching up to ~2048 inputs per call,
  // but we cap at MAX_BATCH_SIZE for memory safety.
  const results: (number[] | null)[] = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const batchStartTime = Date.now();
    try {
      const response = await client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: batch,
      });
      const latencyMs = Date.now() - batchStartTime;
      logger.debug(
        'Batch embedding request completed',
        { latencyMs, batchSize: batch.length, batchOffset: i },
        'EmbeddingClient'
      );

      // Response data is ordered by index
      const sorted = response.data.sort((a, b) => a.index - b.index);
      for (const item of sorted) {
        results.push(item.embedding);
      }
    } catch (error) {
      const latencyMs = Date.now() - batchStartTime;
      logger.error(
        'Batch embedding request failed',
        {
          error: error instanceof Error ? error.message : String(error),
          latencyMs,
          batchOffset: i,
          batchSize: batch.length,
          totalTexts: texts.length,
        },
        'EmbeddingClient'
      );
      // Fill failed batch with nulls, preserve earlier successful results
      for (let j = 0; j < batch.length; j++) {
        results.push(null);
      }
    }
  }

  return results;
}

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns a value in [-1, 1] where 1 means identical direction.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dot / denominator;
}
