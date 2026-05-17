/**
 * Public types for `@elizaos/plugin-mlx`.
 *
 * `mlx-lm.server` exposes an OpenAI-compatible HTTP surface (`/v1/chat/completions`,
 * `/v1/completions`, `/v1/embeddings`, `/v1/models`) so this plugin shares the same
 * core concepts as `@elizaos/plugin-openai` and `@elizaos/plugin-lmstudio`, but
 * defaults to mlx-lm's local server on `http://localhost:8080/v1`.
 */

export interface MlxConfig {
  /** Resolved base URL — typically `http://localhost:8080/v1`. Always normalized to include `/v1`. */
  baseUrl: string;
  /** Optional bearer token. mlx-lm.server doesn't require one by default. */
  apiKey?: string;
  /** Default small model identifier (a HuggingFace ID under `mlx-community/...` or a local path). */
  smallModel?: string;
  /** Default large model identifier. */
  largeModel?: string;
  /** Default embedding model identifier (only if mlx-lm serves embeddings). */
  embeddingModel?: string;
}

/**
 * Shape of an entry from `GET /v1/models` against mlx-lm.server. The endpoint
 * returns an OpenAI-shaped list response; we only depend on `id` for routing.
 */
export interface MlxModelInfo {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

/**
 * Shape of the `GET /v1/models` response.
 */
export interface MlxModelsResponse {
  object: "list";
  data: MlxModelInfo[];
}
