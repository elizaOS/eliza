/**
 * Type definitions for the Google GenAI plugin.
 */

/**
 * Token usage information from API response.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Parameters for text generation.
 */
export interface TextGenerationParams {
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
  stopSequences?: string[];
}

/**
 * Response from text generation.
 */
export interface TextGenerationResponse {
  text: string;
  usage: TokenUsage;
  model: string;
}

/**
 * Parameters for embedding generation.
 */
export interface EmbeddingParams {
  text: string;
}

/**
 * Response from embedding generation.
 */
export interface EmbeddingResponse {
  embedding: number[];
  model: string;
}

/**
 * Parameters for image description.
 */
export interface ImageDescriptionParams {
  imageUrl: string;
  prompt?: string;
}

/**
 * Response from image description.
 */
export interface ImageDescriptionResponse {
  title: string;
  description: string;
}

/**
 * Alias for backwards compatibility.
 * @deprecated Use ImageDescriptionResponse instead.
 */
export type GoogleGenAIImageDescriptionResult = ImageDescriptionResponse;

/**
 * Parameters for object generation.
 */
export interface ObjectGenerationParams {
  prompt: string;
  system?: string;
  schema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Response from object generation.
 */
export interface ObjectGenerationResponse {
  object: Record<string, unknown>;
  usage: TokenUsage;
  model: string;
}
