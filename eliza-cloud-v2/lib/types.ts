/**
 * Type definitions and re-exports.
 *
 * This module re-exports types from database schemas and provides additional utility types.
 * Schemas are the single source of truth for type inference using InferSelectModel and InferInsertModel.
 */

// Re-export all types from schemas for convenience
export type { Organization, NewOrganization } from "@/db/schemas/organizations";

export type { User, NewUser } from "@/db/schemas/users";

export type { ApiKey, NewApiKey } from "@/db/schemas/api-keys";

export type { UsageRecord, NewUsageRecord } from "@/db/schemas/usage-records";

export type {
  CreditTransaction,
  NewCreditTransaction,
} from "@/db/schemas/credit-transactions";

export type { CreditPack, NewCreditPack } from "@/db/schemas/credit-packs";

export type { Generation, NewGeneration } from "@/db/schemas/generations";

export type {
  Conversation,
  NewConversation,
  ConversationMessage,
  NewConversationMessage,
} from "@/db/schemas/conversations";

export type {
  UserCharacter,
  NewUserCharacter,
} from "@/db/schemas/user-characters";

export type { Job, NewJob } from "@/db/schemas/jobs";

export type { ModelPricing, NewModelPricing } from "@/db/schemas/model-pricing";

export type {
  ProviderHealth,
  NewProviderHealth,
} from "@/db/schemas/provider-health";

export type {
  App,
  NewApp,
  AppUser,
  NewAppUser,
  AppAnalytics,
  NewAppAnalytics,
} from "@/db/schemas/apps";

export type { Invoice, NewInvoice } from "@/db/schemas/invoices";

// Repository-specific composite types
export type { UserWithOrganization } from "@/db/repositories/users";
export type { ConversationWithMessages } from "@/db/repositories/conversations";
export type { UsageStats } from "@/db/repositories/usage-records";
export type { Container } from "@/db/repositories/containers";

// Cache and stats types
export type { AgentStats } from "@/lib/cache/agent-state-cache";
export type { DashboardAgentStats } from "@/lib/actions/dashboard";

// Shared character types
export type {
  CategoryId,
  SortBy,
  SortOrder,
  CharacterSource,
  CharacterStats,
  ExtendedCharacter,
  SearchFilters,
  SortOptions,
  PaginationOptions,
  PaginationResult,
  CategoryInfo,
  CloneCharacterOptions,
  TrackingResponse,
} from "./types/characters";

// Shared knowledge types
export type { KnowledgeDocument, QueryResult } from "./types/knowledge";

// Shared MCP types
export type { McpServerConfig, McpSettings } from "./types/mcp";
export type { McpRegistryEntry } from "@/app/api/mcp/registry/route";

// Shared event types
export type { CreditUpdateEvent } from "@/lib/events/credit-events-redis";
export type { AgentEvent } from "@/lib/events/agent-events";

// Shared container types
export type { LogLevel, ParsedLogEntry } from "./types/containers";

// Shared video types
export type { FalVideoData, FalVideoResponse } from "./types/video";

/**
 * Settings for conversation configuration.
 */
export interface ConversationSettings {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  systemPrompt?: string;
}

/**
 * Metadata associated with usage records.
 */
export interface UsageMetadata {
  /** IP address of the request. */
  ip_address?: string;
  /** User agent string. */
  user_agent?: string;
  /** Unique request identifier. */
  request_id?: string;
  /** Additional metadata fields. */
  [key: string]: unknown;
}

/**
 * Template type for dynamic content generation.
 */
export type TemplateType =
  | string
  | ((options: { state: Record<string, unknown> }) => string);

/**
 * Character definition for Eliza AI agents.
 */
export interface ElizaCharacter {
  id?: string;
  name: string;
  username?: string;
  system?: string;
  templates?: {
    [key: string]: TemplateType;
  };
  bio: string | string[];
  messageExamples?: Array<
    Array<{
      name: string;
      content: {
        text: string;
        action?: string;
        [key: string]: unknown;
      };
    }>
  >;
  postExamples?: string[];
  topics?: string[];
  adjectives?: string[];
  knowledge?: (string | { path: string; shared?: boolean })[];
  plugins?: string[];
  avatarUrl?: string;
  settings?: Record<
    string,
    string | boolean | number | Record<string, unknown>
  >;
  secrets?: Record<string, string | boolean | number>;
  style?: {
    all?: string[];
    chat?: string[];
    post?: string[];
  };
  avatar_url?: string;
  isPublic?: boolean;
}
