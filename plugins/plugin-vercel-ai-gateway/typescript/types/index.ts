/**
 * Vercel AI Gateway Plugin Types
 *
 * Strong types for all API interactions with the Vercel AI Gateway.
 */

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Vercel AI Gateway client configuration.
 */
export interface GatewayConfig {
  /** API key for authentication (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN) */
  apiKey: string;
  /** Base URL for the gateway (default: https://ai-gateway.vercel.sh/v1) */
  baseUrl: string;
  /** Small model identifier (default: gpt-5-mini) */
  smallModel: string;
  /** Large model identifier (default: gpt-5) */
  largeModel: string;
  /** Embedding model identifier (default: text-embedding-3-small) */
  embeddingModel: string;
  /** Embedding dimensions (default: 1536) */
  embeddingDimensions: number;
  /** Image generation model (default: dall-e-3) */
  imageModel: string;
  /** Request timeout in milliseconds (default: 60000) */
  timeoutMs: number;
}

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: Omit<GatewayConfig, "apiKey"> = {
  baseUrl: "https://ai-gateway.vercel.sh/v1",
  smallModel: "gpt-5-mini",
  largeModel: "gpt-5",
  embeddingModel: "text-embedding-3-small",
  embeddingDimensions: 1536,
  imageModel: "dall-e-3",
  timeoutMs: 60000,
};

// ============================================================================
// Request Parameters
// ============================================================================

/**
 * Parameters for text generation.
 */
export interface TextGenerationParams {
  /** The prompt for generation */
  prompt: string;
  /** Optional system message */
  system?: string;
  /** Model to use (overrides config) */
  model?: string;
  /** Sampling temperature (0.0-2.0) - not supported for reasoning models */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Frequency penalty (-2.0-2.0) */
  frequencyPenalty?: number;
  /** Presence penalty (-2.0-2.0) */
  presencePenalty?: number;
  /** Stop sequences */
  stopSequences?: string[];
  /** Whether to stream the response */
  stream?: boolean;
  /** Callback for streaming chunks */
  onStreamChunk?: (chunk: string) => void;
}

/**
 * Parameters for embedding generation.
 */
export interface EmbeddingParams {
  /** The text to embed */
  text: string;
  /** Model to use (overrides config) */
  model?: string;
  /** Embedding dimensions (overrides config) */
  dimensions?: number;
}

/**
 * Parameters for object/JSON generation.
 */
export interface ObjectGenerationParams {
  /** The prompt describing the object to generate */
  prompt: string;
  /** Optional JSON schema */
  schema?: Record<string, unknown>;
  /** Model to use (overrides config) */
  model?: string;
  /** Sampling temperature (0.0-2.0) */
  temperature?: number;
  /** Maximum tokens for response */
  maxTokens?: number;
}

/**
 * Image size options.
 */
export type ImageSize =
  | "256x256"
  | "512x512"
  | "1024x1024"
  | "1792x1024"
  | "1024x1792";

/**
 * Image quality options.
 */
export type ImageQuality = "standard" | "hd";

/**
 * Image style options.
 */
export type ImageStyle = "vivid" | "natural";

/**
 * Parameters for image generation.
 */
export interface ImageGenerationParams {
  /** The prompt describing the image */
  prompt: string;
  /** Model to use (overrides config) */
  model?: string;
  /** Number of images to generate (1-10) */
  n?: number;
  /** Image size */
  size?: ImageSize;
  /** Image quality */
  quality?: ImageQuality;
  /** Image style */
  style?: ImageStyle;
}

/**
 * Parameters for image description.
 */
export interface ImageDescriptionParams {
  /** URL of the image to analyze */
  imageUrl: string;
  /** Custom prompt for analysis */
  prompt?: string;
  /** Model to use for vision */
  model?: string;
  /** Maximum tokens for response */
  maxTokens?: number;
}

// ============================================================================
// Response Types
// ============================================================================

/**
 * Result from image generation.
 */
export interface ImageGenerationResult {
  /** URL of the generated image */
  url: string;
  /** Revised prompt (if applicable) */
  revisedPrompt?: string;
}

/**
 * Result from image description.
 */
export interface ImageDescriptionResult {
  /** Title for the image */
  title: string;
  /** Detailed description */
  description: string;
}

/**
 * Token usage statistics.
 */
export interface TokenUsage {
  /** Number of prompt tokens */
  promptTokens: number;
  /** Number of completion tokens */
  completionTokens: number;
  /** Total tokens used */
  totalTokens: number;
}

/**
 * Chat message role.
 */
export type MessageRole = "system" | "user" | "assistant";

/**
 * Chat message structure.
 */
export interface ChatMessage {
  /** Role of the message sender */
  role: MessageRole;
  /** Message content */
  content: string | null;
}

/**
 * Chat completion choice.
 */
export interface ChatCompletionChoice {
  /** Index of the choice */
  index: number;
  /** The message */
  message: ChatMessage;
  /** Finish reason */
  finishReason: string | null;
}

/**
 * Chat completion response from the API.
 */
export interface ChatCompletionResponse {
  /** Response ID */
  id: string;
  /** Object type */
  object: "chat.completion";
  /** Creation timestamp */
  created: number;
  /** Model used */
  model: string;
  /** Completion choices */
  choices: ChatCompletionChoice[];
  /** Token usage */
  usage?: TokenUsage;
}

/**
 * Embedding data item.
 */
export interface EmbeddingData {
  /** The embedding vector */
  embedding: number[];
  /** Index of the embedding */
  index: number;
}

/**
 * Embedding response from the API.
 */
export interface EmbeddingResponse {
  /** Object type */
  object: "list";
  /** Embedding data */
  data: EmbeddingData[];
  /** Model used */
  model: string;
  /** Token usage */
  usage: TokenUsage;
}

/**
 * Image response data item.
 */
export interface ImageResponseData {
  /** URL of the generated image */
  url: string;
  /** Revised prompt */
  revised_prompt?: string;
}

/**
 * Image generation response from the API.
 */
export interface ImageGenerationResponse {
  /** Creation timestamp */
  created: number;
  /** Image data */
  data: ImageResponseData[];
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Gateway client error.
 */
export class GatewayError extends Error {
  /** HTTP status code (if applicable) */
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "GatewayError";
    this.statusCode = statusCode;
  }
}


