/**
 * Public types for `@elizaos/plugin-lmstudio`.
 *
 * LM Studio exposes an OpenAI-compatible HTTP surface, so this plugin shares the same
 * core concepts as `@elizaos/plugin-openai` (chat completions, embeddings, models list),
 * but defaults to LM Studio's local server on `http://localhost:1234/v1`.
 */

export interface LMStudioConfig {
  /** Resolved base URL — typically `http://localhost:1234/v1`. Always normalized to include `/v1`. */
  baseUrl: string;
  /** Optional API key. LM Studio doesn't require one by default. */
  apiKey?: string;
  /** Default small model identifier. */
  smallModel?: string;
  /** Default large model identifier. */
  largeModel?: string;
  /** Default embedding model identifier (only if LM Studio serves embeddings). */
  embeddingModel?: string;
}

/**
 * Shape of an LM Studio model entry from `GET /v1/models`. LM Studio returns
 * an OpenAI-shaped list response; we only depend on `id` for routing.
 */
export interface LMStudioModelInfo {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

/**
 * Shape of `GET /v1/models` response.
 */
export interface LMStudioModelsResponse {
  object: "list";
  data: LMStudioModelInfo[];
}
