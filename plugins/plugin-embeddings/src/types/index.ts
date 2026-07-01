/** Plugin-local types for `@elizaos/plugin-embeddings`. */

/** Token usage as reported by an OpenAI-compatible embeddings response. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * OpenAI-compatible `/embeddings` response shape. Voyage, TEI, Infinity, vLLM,
 * LM Studio, and Eliza Cloud all return this same structure.
 */
export interface EmbeddingResponse {
  object: "list";
  data: Array<{
    object: "embedding";
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage?: {
    prompt_tokens: number;
    total_tokens: number;
  };
}
