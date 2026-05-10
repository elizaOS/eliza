/**
 * Type definitions and re-exports.
 *
 * This module re-exports types from database schemas and provides additional utility types.
 * Schemas are the single source of truth for type inference using InferSelectModel and InferInsertModel.
 */

export type { Container } from "@/db/repositories/containers";
export type { ConversationWithMessages } from "@/db/repositories/conversations";
export type { UsageStats } from "@/db/repositories/usage-records";
// Repository-specific composite types
export type { UserWithOrganization } from "@/db/repositories/users";
export type { ApiKey, NewApiKey } from "@/db/schemas/api-keys";
export type {
  App,
  AppAnalytics,
  AppUser,
  NewApp,
  NewAppAnalytics,
  NewAppUser,
} from "@/db/schemas/apps";

export type {
  Conversation,
  ConversationMessage,
  NewConversation,
  NewConversationMessage,
} from "@/db/schemas/conversations";
export type { CreditPack, NewCreditPack } from "@/db/schemas/credit-packs";
export type {
  CreditTransaction,
  NewCreditTransaction,
} from "@/db/schemas/credit-transactions";
export type { Generation, NewGeneration } from "@/db/schemas/generations";
export type { Invoice, NewInvoice } from "@/db/schemas/invoices";
export type { Job, NewJob } from "@/db/schemas/jobs";
export type { ModelPricing, NewModelPricing } from "@/db/schemas/model-pricing";
// Re-export all types from schemas for convenience
export type { NewOrganization, Organization } from "@/db/schemas/organizations";
export type {
  NewProviderHealth,
  ProviderHealth,
} from "@/db/schemas/provider-health";
export type { NewUsageRecord, UsageRecord } from "@/db/schemas/usage-records";
export type {
  NewUserCharacter,
  UserCharacter,
} from "@/db/schemas/user-characters";
export type { NewUser, User } from "@/db/schemas/users";
// Cache and stats types
export type { AgentStats } from "@/lib/cache/agent-state-cache";
// Shared event types
export type { CreditUpdateEvent } from "@/lib/events/credit-events-redis";
// Shared character types
export type {
  CategoryId,
  CategoryInfo,
  CharacterSource,
  CharacterStats,
  CloneCharacterOptions,
  ExtendedCharacter,
  PaginationOptions,
  PaginationResult,
  SearchFilters,
  SortBy,
  SortOptions,
  SortOrder,
  TrackingResponse,
} from "./types/characters";
// Shared container types
export type { LogLevel, ParsedLogEntry } from "./types/containers";
export type { CryptoStatusResponse } from "./types/crypto-status";
export type { DashboardAgentStats } from "./types/dashboard-agent-stats";
// Shared document types
export type { CloudDocument, QueryResult } from "./types/documents";
// Shared MCP types
export type { McpServerConfig, McpSettings } from "./types/mcp";
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

export type { ElizaCharacter, TemplateType } from "./types/eliza-character";
