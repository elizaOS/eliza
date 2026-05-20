/**
 * @feed/shared
 *
 * Shared types, constants, and utilities for Feed.
 * This package exports only client-safe code that can run in the browser.
 *
 * For server-only utilities, import from @feed/api:
 * - Storage: import { getStorageClient } from '@feed/api'
 * - Monitoring: import { performanceMonitor } from '@feed/api'
 * - Token counting: import { countTokens, countTokensSync } from '@feed/api'
 */

// =============================================================================
// Constants (all client-safe)
// =============================================================================

export * from "./constants";
export {
  AGENT_TRANSFER_IN_TRANSACTION_TYPE,
  AGENT_TRANSFER_OUT_TRANSACTION_TYPE,
  CANONICAL_AGENT_TRANSFER_TRANSACTION_TYPES,
  CANONICAL_PEER_TRANSFER_TRANSACTION_TYPES,
  PEER_TRANSFER_IN_TRANSACTION_TYPE,
  PEER_TRANSFER_OUT_TRANSACTION_TYPE,
} from "./constants/constants";
export * from "./model-pilot-inquiry";

// =============================================================================
// Types (all types are client-safe - they're just TypeScript interfaces)
// =============================================================================

export * from "./types";

// =============================================================================
// Game Types (Actor, FeedPost, Question, etc.)
// =============================================================================

export * from "./game-types";

// =============================================================================
// Pack Types (PackManifest, PackActor, PackOrganization, etc.)
// =============================================================================

export * from "./pack-types";

// =============================================================================
// Perps Types
// =============================================================================

export * from "./perps-types";

// =============================================================================
// Client-Safe Utilities (excludes token-counter which uses tiktoken)
// =============================================================================

// Assets utilities (URL helpers)
export * from "./utils/assets";
// Chain utilities (chain name mapping)
export * from "./utils/chain-utils";
// Content analysis (pure functions, no external deps)
export * from "./utils/content-analysis";
// Content safety (pure functions, no external deps)
export * from "./utils/content-safety";
// Decimal converter (pure functions)
export * from "./utils/decimal-converter";
// Formatting utilities (pure functions)
export * from "./utils/format";
// JSON parser (pure functions)
export * from "./utils/json-parser";
// Logger (works in browser)
export * from "./utils/logger";
// Name replacement utilities (pure functions)
export * from "./utils/name-replacement";
// OASF skill mapper (pure functions)
export * from "./utils/oasf-skill-mapper";
// Post utilities (pure functions)
export * from "./utils/post-utils";
// Profile utilities (pure functions)
export * from "./utils/profile";
// Retry utilities (pure functions)
export * from "./utils/retry";
export * from "./utils/reward-notifications";
// Singleton utility (pure function)
export * from "./utils/singleton";
// Snowflake ID generator (pure functions)
export * from "./utils/snowflake";
// Transaction utilities (pure functions)
export * from "./utils/transactions";
// UI utilities (cn function for Tailwind)
export * from "./utils/ui";
// User identifier classification (pure functions)
export * from "./utils/user-identifier";
// Username utilities (pure functions)
export * from "./utils/username";
// UUID generation (cross-browser compatible UUID v4)
export * from "./utils/uuid";
export * from "./utils/wallet";

// =============================================================================
// Error Classes (client-safe)
// =============================================================================

export * from "./errors";

// =============================================================================
// Auth utilities (client-safe parts)
// =============================================================================

export * from "./auth";

// =============================================================================
// Onboarding utilities
// =============================================================================

export * from "./onboarding";

// =============================================================================
// Validation utilities and schemas (Zod schemas work in browser)
// =============================================================================

export * from "./validation";
export type {
  LeaderboardMetric,
  LeaderboardScope,
} from "./validation/schemas/common";
export {
  LEADERBOARD_METRICS,
  LEADERBOARD_SCOPES,
} from "./validation/schemas/common";

// =============================================================================
// Referral utilities
// =============================================================================

export * from "./referral";

// =============================================================================
// Share utilities
// =============================================================================

export * from "./share";

// =============================================================================
// Public configuration (canonical contract addresses, endpoints, game settings)
// =============================================================================

export * from "./config";

// =============================================================================
// DAG Trace Bridge (cross-package LLM call forwarding for observability)
// =============================================================================

export * from "./dag-trace-bridge";

// =============================================================================
// NOT EXPORTED (Server-only modules - import from @feed/api):
// =============================================================================
// - Token counting: import { countTokens, countTokensSync } from '@feed/api'
// - Storage: import { getStorageClient } from '@feed/api'
// - Monitoring: import { performanceMonitor } from '@feed/api'
// - Rate limiting (user-level): import { checkRateLimit, RATE_LIMIT_CONFIGS } from '@feed/api'
