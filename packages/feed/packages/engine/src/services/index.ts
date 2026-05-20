/**
 * Engine Services
 *
 * @module engine/services
 *
 * @description
 * Game engine services for NPCs, markets, content generation, and game mechanics.
 */

// =============================================================================
// NPC Services
// =============================================================================

export * from "./ActorSocialActions";
export * from "./activity-pattern-service";
export * from "./actor-context-builder";
export * from "./alpha-group-invite-service";
export * from "./arc-context-service";
export * from "./capital-allocation-service";
export * from "./event-reaction-service";
export * from "./following-mechanics";
export * from "./game-onboarding-service";
// Group Chat Service
export {
  GroupChatService,
  type InviteChance,
  type SweepDecision,
} from "./group-chat-service";
export * from "./InteractionTracker";
export * from "./initial-investment-service";
export * from "./jsonb-validators";
export * from "./lookahead-generation-service";
export * from "./message-quality-checker";
export * from "./narrative-event-processor";
export * from "./npc-follow-bootstrap";
export * from "./npc-group-chat-onboarding-service";
export * from "./npc-group-dynamics-service";
export * from "./npc-interaction-tracker";
export * from "./npc-memory-service";
export * from "./npc-persona-generator";
export * from "./npc-positions-context-service";
export * from "./npc-running-bit-service";
export * from "./npc-social-engagement-service";
export * from "./npc-trade-rate-limiter";
export * from "./player-influence-service";
export * from "./posting-probability-service";
export * from "./reply-rate-limiter";
export * from "./shared-chat-context-service";
export * from "./tier-config";
export * from "./tiered-group-service";
export * from "./training-quality-monitor";
export * from "./user-alpha-group-assignment-service";

// =============================================================================
// Market Services
// =============================================================================

export {
  type EventArcValidationResult,
  EventArcValidator,
} from "./event-arc-validator";
export * from "./event-market-linker"; // BAB-5: Event-market connection
// Event-market pipeline for narrative-driven market impacts
export * from "./event-market-pipeline";
export * from "./market-metrics-service"; // BAB-5: Metrics-based question generation
export * from "./market-momentum-service"; // Cascade/herd behavior for NPC trading
export * from "./market-mover-agent";
export * from "./market-timeframes"; // Multi-timeframe market system
export * from "./perp-price-impact-port";
export * from "./prediction-market-profiles";
export * from "./price-update-service";
export * from "./signal-extraction-service";
export * from "./sub-market-service"; // Sub-market spawning
export * from "./timeframe-arc-planner"; // Compressed arc planning for timeframe markets
export * from "./timeframe-arc-processor"; // Time-based arc state machine

// =============================================================================
// Content Generation
// =============================================================================

export * from "./agent-avatar-service";
export * from "./article-image-service";
export * from "./article-persistence";
export * from "./article-rate-limiter";
export * from "./content-grounding-validator";
export * from "./content-quality-gate";
export * from "./event-generation-helpers";
export * from "./narrative-state-service";
export * from "./npc-anti-repetition-service";
export * from "./npc-character-config";
export * from "./parody-headline-generator";
export * from "./post-generation-helpers";
export * from "./question-arc-planner";
export * from "./story-seed-service";
// Tag Service
export {
  type GeneratedTag,
  generateTagsForPosts,
  generateTagsFromPost,
  getCurrentTrendingTags,
  getPostsByTag,
  getRelatedTags,
  getTagStatistics,
  getTagsForPost,
  storeTagsForPost,
  storeTrendingTags,
} from "./tag-service";
export * from "./topic-diversity-service";
export * from "./trending-calculation-service";
export * from "./trending-grouping-service";

// =============================================================================
// Core Services
// =============================================================================

export * from "./agent-trade-notification";
export * from "./character-mapping-service";
export * from "./daily-topic-service";
export * from "./distributed-lock-service";
export * from "./dm-service";
export * from "./earned-points-service";
export * from "./fee-redistribution-service"; // Stability fund for NPC liquidity
export * from "./fee-service";
export {
  bootstrapGameIfNeeded,
  type GameBootstrapResult,
  GameBootstrapService,
} from "./game-bootstrap-service";
// Game Context Cache for shared cron data
export {
  type ActiveQuestion,
  GameContextCache,
  type GameState,
  type RecentWorldEvent,
} from "./game-context-cache";
export * from "./group-chat-invite-notifier";
export * from "./market-context-service";
export * from "./market-impact-service";
export * from "./npc-wallet-adapter";
export * from "./realtime-broadcaster";
export * from "./rss-feed-service";
export * from "./scambench-scenario-seeding-service";
export * from "./static-data-registry";
export * from "./trade-cache-invalidation";
export * from "./trade-execution-service";
export * from "./wallet-service";
export * from "./world-facts-consolidator";
export * from "./world-facts-generator";
export * from "./world-state-snapshot-service";

// =============================================================================
// Portfolio Services
// =============================================================================

export {
  calculatePortfolioBreakdown,
  type PortfolioBreakdownSnapshot,
} from "./portfolio-breakdown";
export {
  calculatePortfolioPnL,
  type PortfolioPnLSnapshot,
} from "./portfolio-pnl";

// =============================================================================
// Reputation Service (includes sync interface)
// =============================================================================

export {
  getReputationSyncService,
  ReputationService,
  type ReputationSyncOptions,
  type ReputationSyncResult,
  type ReputationSyncServiceInterface,
  setReputationSyncService,
  syncReputationIfAvailable,
} from "./reputation-service";

// =============================================================================
// Token Statistics Service
// =============================================================================

export { tokenStatsService } from "./token-stats-service";
