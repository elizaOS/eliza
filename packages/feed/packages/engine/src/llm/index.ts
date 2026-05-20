/**
 * Babylon LLM Client Package
 * LLM utilities and clients for structured generation
 */

export {
  cosineSimilarity,
  getEmbedding,
  getEmbeddings,
} from './embedding-client';
export {
  cleanMarkdownCodeBlocks,
  extractJsonFromText,
  parseContinuationContent,
} from './json-continuation-parser';
export { BabylonLLMClient } from './openai-client';
export { parseXML, stripThinkingBlocks } from './xml-parser';

/**
 * For LLM response caching, use the existing Redis-backed cache service:
 *
 * @example
 * ```typescript
 * import { getCacheOrFetch } from '@babylon/api';
 *
 * const response = await getCacheOrFetch(
 *   `llm:${promptHash}`,
 *   () => llmClient.generateJSON(prompt),
 *   { namespace: 'llm', ttl: 300 }
 * );
 * ```
 */
