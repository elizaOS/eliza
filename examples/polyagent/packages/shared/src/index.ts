/**
 * @polyagent/shared
 *
 * Shared types, constants, and utilities for Polyagent.
 * This package exports only client-safe code that can run in the browser.
 *
 * For server-only utilities, import from @polyagent/api:
 * - Storage: import { getStorageClient } from '@polyagent/api'
 * - Monitoring: import { performanceMonitor } from '@polyagent/api'
 * - Token counting: import { countTokens, countTokensSync } from '@polyagent/api'
 */

// =============================================================================
// Constants (all client-safe)
// =============================================================================

export * from "./constants";

// =============================================================================
// Types (all types are client-safe - they're just TypeScript interfaces)
// =============================================================================

export * from "./types";

// =============================================================================
// Game Types (Actor, FeedPost, Question, etc.)
// =============================================================================

export * from "./game-types";

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
// Profile utilities (pure functions)
export * from "./utils/profile";
// Retry utilities (pure functions)
export * from "./utils/retry";
// Singleton utility (pure function)
export * from "./utils/singleton";
// Snowflake ID generator (pure functions)
export * from "./utils/snowflake";
// UI utilities (cn function for Tailwind)
export * from "./utils/ui";

// =============================================================================
// Error Classes (client-safe)
// =============================================================================

export * from "./errors";

// =============================================================================
// Auth utilities (client-safe parts)
// =============================================================================

export * from "./auth";

// =============================================================================
// Contracts (ABIs and addresses - pure data)
// =============================================================================

export * from "./contracts";

// =============================================================================
// Onboarding utilities
// =============================================================================

export * from "./onboarding";

// =============================================================================
// Validation utilities and schemas (Zod schemas work in browser)
// =============================================================================

export * from "./validation";

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
// NOT EXPORTED (Server-only modules - import from @polyagent/api):
// =============================================================================
// - Token counting: import { countTokens, countTokensSync } from '@polyagent/api'
// - Storage: import { getStorageClient } from '@polyagent/api'
// - Monitoring: import { performanceMonitor } from '@polyagent/api'
// - Rate limiting (user-level): import { checkRateLimit, RATE_LIMIT_CONFIGS } from '@polyagent/api'
