import z from 'zod';
import { UUID } from '@elizaos/core';
import { Buffer } from 'node:buffer';

// Schema for validating model configuration
export const ModelConfigSchema = z.object({
  // Provider configuration
  // NOTE: If EMBEDDING_PROVIDER is not specified, the plugin automatically assumes
  // plugin-openai is being used and will use OPENAI_EMBEDDING_MODEL and
  // OPENAI_EMBEDDING_DIMENSIONS for configuration
  EMBEDDING_PROVIDER: z.enum(['openai', 'google']),
  TEXT_PROVIDER: z.enum(['openai', 'anthropic', 'openrouter', 'google']).optional(),

  // API keys
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),

  // Base URLs (optional for most providers)
  OPENAI_BASE_URL: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().optional(),
  GOOGLE_BASE_URL: z.string().optional(),

  // Model names
  TEXT_EMBEDDING_MODEL: z.string(),
  TEXT_MODEL: z.string().optional(),

  // Token limits
  MAX_INPUT_TOKENS: z
    .string()
    .or(z.number())
    .transform((val) => (typeof val === 'string' ? parseInt(val, 10) : val)),
  MAX_OUTPUT_TOKENS: z
    .string()
    .or(z.number())
    .optional()
    .transform((val) => (val ? (typeof val === 'string' ? parseInt(val, 10) : val) : 4096)),

  // Embedding dimension
  // For OpenAI: Only applies to text-embedding-3-small and text-embedding-3-large models
  // Default: 1536 dimensions
  EMBEDDING_DIMENSION: z
    .string()
    .or(z.number())
    .optional()
    .transform((val) => (val ? (typeof val === 'string' ? parseInt(val, 10) : val) : 1536)),

  // Contextual RAG settings
  CTX_RAG_ENABLED: z.boolean().default(false),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/**
 * Interface for provider rate limits
 */
export interface ProviderRateLimits {
  // Maximum concurrent requests recommended for this provider
  maxConcurrentRequests: number;
  // Maximum requests per minute allowed
  requestsPerMinute: number;
  // Maximum tokens per minute allowed (if applicable)
  tokensPerMinute?: number;
  // Name of the provider
  provider: string;
}

/**
 * Options for text generation overrides
 */
export interface TextGenerationOptions {
  provider?: 'anthropic' | 'openai' | 'openrouter' | 'google';
  modelName?: string;
  maxTokens?: number;
  /**
   * Document to cache for contextual retrieval.
   * When provided (along with an Anthropic model via OpenRouter), this enables prompt caching.
   * The document is cached with the provider and subsequent requests will reuse the cached document,
   * significantly reducing costs for multiple operations on the same document.
   * Most effective with contextual retrieval for RAG applications.
   */
  cacheDocument?: string;

  /**
   * Options for controlling the cache behavior.
   * Currently supports { type: 'ephemeral' } which sets up a temporary cache.
   * Cache expires after approximately 5 minutes with Anthropic models.
   * This can reduce costs by up to 90% for reads after the initial cache write.
   */
  cacheOptions?: {
    type: 'ephemeral';
  };
  /**
   * Whether to automatically detect and enable caching for contextual retrieval.
   * Default is true for OpenRouter+Anthropic models with document-chunk prompts.
   * Set to false to disable automatic caching detection.
   */
  autoCacheContextualRetrieval?: boolean;
}

/**
 * Options for adding knowledge to the system
 */
export interface AddKnowledgeOptions {
  /** Client-provided document ID */
  clientDocumentId: UUID;
  /** MIME type of the file */
  contentType: string;
  /** Original filename */
  originalFilename: string;
  /** World ID for storage */
  worldId: UUID;
  /**
   * Content of the document. Should be:
   * - Base64 encoded string for binary files (PDFs, DOCXs, etc)
   * - Plain text for text files
   */
  content: string;
  /** Optional room ID for storage scoping */
  roomId?: UUID;
  /** Optional entity ID for storage scoping */
  entityId?: UUID;
}
