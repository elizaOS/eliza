import type { Content, UUID } from "@elizaos/core";
import z from "zod";

/**
 * Local metadata type for stored knowledge items.
 * Uses a permissive record type to avoid conflicts between TypeScript and protobuf MemoryMetadata types.
 */
export type StoredKnowledgeMetadata = Record<string, unknown>;

/**
 * Stored knowledge item with content, metadata, and optional similarity score.
 * Used for knowledge retrieval results and internal knowledge processing.
 * This is a local definition to avoid conflicts with the proto KnowledgeItem type.
 */
export interface StoredKnowledgeItem {
  id: UUID;
  content: Content;
  metadata?: StoredKnowledgeMetadata;
  worldId?: UUID;
  similarity?: number;
}

export const ModelConfigSchema = z.object({
  EMBEDDING_PROVIDER: z.enum(["openai", "google"]).optional(),
  TEXT_PROVIDER: z.enum(["openai", "anthropic", "openrouter", "google"]).optional(),

  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),

  OPENAI_BASE_URL: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().optional(),
  GOOGLE_BASE_URL: z.string().optional(),

  TEXT_EMBEDDING_MODEL: z.string(),
  TEXT_MODEL: z.string().optional(),

  MAX_INPUT_TOKENS: z
    .string()
    .or(z.number())
    .transform((val) => (typeof val === "string" ? parseInt(val, 10) : val)),
  MAX_OUTPUT_TOKENS: z
    .string()
    .or(z.number())
    .optional()
    .transform((val) => (val ? (typeof val === "string" ? parseInt(val, 10) : val) : 4096)),

  EMBEDDING_DIMENSION: z
    .string()
    .or(z.number())
    .optional()
    .transform((val) => (val ? (typeof val === "string" ? parseInt(val, 10) : val) : 1536)),

  LOAD_DOCS_ON_STARTUP: z.boolean().default(false),

  CTX_KNOWLEDGE_ENABLED: z.boolean().default(false),

  RATE_LIMIT_ENABLED: z.boolean().default(true),

  MAX_CONCURRENT_REQUESTS: z
    .string()
    .or(z.number())
    .optional()
    .transform((val) => (val ? (typeof val === "string" ? parseInt(val, 10) : val) : 150)),

  REQUESTS_PER_MINUTE: z
    .string()
    .or(z.number())
    .optional()
    .transform((val) => (val ? (typeof val === "string" ? parseInt(val, 10) : val) : 300)),

  TOKENS_PER_MINUTE: z
    .string()
    .or(z.number())
    .optional()
    .transform((val) => (val ? (typeof val === "string" ? parseInt(val, 10) : val) : 750000)),

  BATCH_DELAY_MS: z
    .string()
    .or(z.number())
    .optional()
    .transform((val) => (val ? (typeof val === "string" ? parseInt(val, 10) : val) : 100)),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export interface ProviderRateLimits {
  maxConcurrentRequests: number;
  requestsPerMinute: number;
  tokensPerMinute?: number;
  provider: string;
  rateLimitEnabled: boolean;
  batchDelayMs: number;
}

export interface TextGenerationOptions {
  provider?: "anthropic" | "openai" | "openrouter" | "google";
  modelName?: string;
  maxTokens?: number;
  cacheDocument?: string;
  cacheOptions?: {
    type: "ephemeral";
  };
  autoCacheContextualRetrieval?: boolean;
}

export interface AddKnowledgeOptions {
  agentId?: UUID;
  worldId: UUID;
  roomId: UUID;
  entityId: UUID;
  clientDocumentId: UUID;
  contentType: string;
  originalFilename: string;
  content: string;
  metadata?: Record<string, unknown>;
}

declare module "@elizaos/core" {
  interface ServiceTypeRegistry {
    KNOWLEDGE: "knowledge";
  }
}

export const KnowledgeServiceType = {
  KNOWLEDGE: "knowledge" as const,
} satisfies Partial<import("@elizaos/core").ServiceTypeRegistry>;

export interface KnowledgeDocumentMetadata extends Record<string, unknown> {
  type: string; // e.g., 'document', 'website_content'
  source: string; // e.g., 'upload', 'web_scrape', path to file
  title?: string;
  filename?: string;
  fileExt?: string;
  fileType?: string; // MIME type
  fileSize?: number;
}

export interface KnowledgeConfig {
  CTX_KNOWLEDGE_ENABLED: boolean;
  LOAD_DOCS_ON_STARTUP: boolean;
  MAX_INPUT_TOKENS?: string | number;
  MAX_OUTPUT_TOKENS?: string | number;
  EMBEDDING_PROVIDER?: string;
  TEXT_PROVIDER?: string;
  TEXT_EMBEDDING_MODEL?: string;
  // Rate limiting configuration
  RATE_LIMIT_ENABLED?: boolean;
  MAX_CONCURRENT_REQUESTS?: number;
  REQUESTS_PER_MINUTE?: number;
  TOKENS_PER_MINUTE?: number;
  BATCH_DELAY_MS?: number;
}

export interface LoadResult {
  successful: number;
  failed: number;
  errors?: Array<{ filename: string; error: string }>;
}

export interface ExtendedMemoryMetadata extends Record<string, unknown> {
  type?: string;
  title?: string;
  filename?: string;
  path?: string;
  description?: string;
  fileExt?: string;
  timestamp?: number;
  contentType?: string;
  documentId?: string;
  source?: string;
  fileType?: string;
  fileSize?: number;
  position?: number; // For fragments
  originalFilename?: string;
  url?: string; // For web content
}
