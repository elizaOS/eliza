/**
 * Core types for the Ollama plugin.
 */

/**
 * Configuration options for the Ollama client.
 */
export interface OllamaConfig {
  /** Base URL for the Ollama API (default: http://localhost:11434) */
  baseUrl: string;
  /** Model for small text generation tasks */
  smallModel: string;
  /** Model for large text generation tasks */
  largeModel: string;
  /** Model for embeddings */
  embeddingModel: string;
  /** Request timeout in milliseconds */
  timeoutMs: number;
}

/**
 * Parameters for text generation.
 */
export interface TextGenerationParams {
  /** The prompt to generate from */
  prompt: string;
  /** Optional system prompt */
  system?: string;
  /** Temperature for generation (0.0 to 1.0) */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Frequency penalty */
  frequencyPenalty?: number;
  /** Presence penalty */
  presencePenalty?: number;
  /** Stop sequences */
  stopSequences?: string[];
}

/**
 * Response from text generation.
 */
export interface TextGenerationResponse {
  /** The generated text */
  text: string;
  /** Model used for generation */
  model: string;
}

/**
 * Parameters for object generation.
 */
export interface ObjectGenerationParams {
  /** The prompt describing the object to generate */
  prompt: string;
  /** Optional system prompt */
  system?: string;
  /** Temperature for generation */
  temperature?: number;
  /** JSON Schema for the expected output (optional) */
  schema?: Record<string, unknown>;
  /** Maximum tokens to generate */
  maxTokens?: number;
}

/**
 * Response from object generation.
 */
export interface ObjectGenerationResponse {
  /** The generated object */
  object: Record<string, unknown>;
  /** Model used for generation */
  model: string;
}

/**
 * Parameters for text embedding.
 */
export interface EmbeddingParams {
  /** The text to embed */
  text: string;
}

/**
 * Response from embedding generation.
 */
export interface EmbeddingResponse {
  /** The embedding vector */
  embedding: number[];
  /** Model used for embedding */
  model: string;
}

/**
 * Ollama API model info.
 */
export interface OllamaModelInfo {
  /** Model name */
  name: string;
  /** Model size in bytes */
  size: number;
  /** Modified timestamp */
  modified_at: string;
}

/**
 * Ollama API tags response.
 */
export interface OllamaTagsResponse {
  /** Available models */
  models: OllamaModelInfo[];
}

