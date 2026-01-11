/**
 * Core types for the OpenRouter plugin.
 */

/**
 * Configuration options for the OpenRouter client.
 */
export interface OpenRouterConfig {
  /** API key for authentication */
  apiKey: string;
  /** Base URL for the OpenRouter API */
  baseUrl: string;
  /** Model for small text generation tasks */
  smallModel: string;
  /** Model for large text generation tasks */
  largeModel: string;
  /** Model for image description */
  imageModel: string;
  /** Model for image generation */
  imageGenerationModel: string;
  /** Model for embeddings */
  embeddingModel: string;
  /** Embedding dimensions */
  embeddingDimensions: number;
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
  /** Temperature for generation (0.0 to 2.0) */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Frequency penalty */
  frequencyPenalty?: number;
  /** Presence penalty */
  presencePenalty?: number;
  /** Stop sequences */
  stopSequences?: string[];
  /** Whether to stream the response */
  stream?: boolean;
}

/**
 * Response from text generation.
 */
export interface TextGenerationResponse {
  /** The generated text */
  text: string;
  /** Model used for generation */
  model: string;
  /** Token usage information */
  usage?: TokenUsage;
}

/**
 * Token usage information.
 */
export interface TokenUsage {
  /** Input/prompt tokens */
  promptTokens: number;
  /** Output/completion tokens */
  completionTokens: number;
  /** Total tokens */
  totalTokens: number;
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
  /** JSON Schema for the expected output */
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
  /** Token usage information */
  usage?: TokenUsage;
}

/**
 * Parameters for image description.
 */
export interface ImageDescriptionParams {
  /** URL of the image to describe */
  imageUrl: string;
  /** Optional prompt to guide description */
  prompt?: string;
}

/**
 * Response from image description.
 */
export interface ImageDescriptionResponse {
  /** The image description */
  description: string;
  /** Model used */
  model: string;
}

/**
 * Parameters for image generation.
 */
export interface ImageGenerationParams {
  /** Prompt describing the image to generate */
  prompt: string;
  /** Image width */
  width?: number;
  /** Image height */
  height?: number;
}

/**
 * Response from image generation.
 */
export interface ImageGenerationResponse {
  /** Base64-encoded image data */
  imageData: string;
  /** Model used */
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
 * OpenRouter model information.
 */
export interface OpenRouterModelInfo {
  /** Model ID */
  id: string;
  /** Model name */
  name: string;
  /** Context length */
  contextLength: number;
  /** Pricing per token */
  pricing: {
    prompt: number;
    completion: number;
  };
}


