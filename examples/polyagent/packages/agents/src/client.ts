/**
 * Polyagent Agents - Client-Safe Exports
 *
 * This module exports types and utilities that are safe to use in client-side code.
 * It does NOT include any server-only dependencies like @elizaos/core, Redis,
 * database connections, or Node.js built-in modules.
 *
 * Use this import for React client components:
 * import type { AgentTemplate, A2AReputationResponse } from '@polyagent/agents/client';
 */

// =============================================================================
// Agent Template Types (used for agent creation UI)
// =============================================================================

export type { AgentTemplate } from "./types/agent-template";

// =============================================================================
// A2A Response Types (used for widget caching and API responses)
// =============================================================================

export type {
  A2ABalanceResponse,
  A2AChat,
  A2AChatMessage,
  A2AChatParticipant,
  A2AChatsResponse,
  A2AFeedPost,
  A2AFeedResponse,
  A2ALeaderboardEntry,
  A2ALeaderboardResponse,
  A2AMarketPosition,
  A2ANotification,
  A2ANotificationsResponse,
  A2AOrganization,
  A2AOrganizationsResponse,
  A2APerpetualMarket,
  A2APerpetualsResponse,
  A2APerpPosition,
  A2APositionsResponse,
  A2APostAuthor,
  A2APredictionMarket,
  A2APredictionsResponse,
  A2AReferral,
  A2AReferralCodeResponse,
  A2AReferralStatsResponse,
  A2AReferralsResponse,
  A2AReputationResponse,
  A2ASystemStatsResponse,
  A2ATradeHistoryEntry,
  A2ATradeHistoryResponse,
  A2ATrendingTag,
  A2ATrendingTagsResponse,
  A2AUnreadCountResponse,
  A2AUserProfileResponse,
  A2AUserSearchResult,
  A2AUsersSearchResponse,
  A2AUserWalletResponse,
} from "./types/a2a-responses";

// =============================================================================
// Common Types (used across client and server)
// =============================================================================

export type { JsonValue } from "./types/common";
