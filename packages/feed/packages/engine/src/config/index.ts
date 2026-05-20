/**
 * Engine Configuration Module
 *
 * Centralized exports for all engine configuration.
 */

// Alpha Group Configuration
export {
  ALPHA_GROUP_CONFIG,
  type AlphaGroupConfig,
  calculateNextEligibleDate,
  DOMAIN_FOCUS_WEIGHTS,
  getFocusWeightsForDomains,
  shouldResetDeclineCount,
} from "./alpha-group-config";

// Content Pacing Configuration
export {
  CONTENT_PACING,
  calculatePostsForTick,
  getTimeOfDayMultiplier,
  isNewDay,
  shouldActorPost,
} from "./content-pacing";

// Fee Configuration
export {
  FEE_CONFIG,
  type FeeTransactionType,
  type FeeType,
} from "./fees";

// NPC Activity Configuration
export {
  getMaxTradesPerDay,
  getMinMinutesBetweenTrades,
  getPreset,
  getTradingProbability,
  logCurrentConfig,
  NPC_ACTIVITY_CONFIG,
  NPC_ACTIVITY_PRESETS,
  NPC_CONTENT_PACING_CONFIG,
  NPC_ENGAGEMENT_CONFIG,
  NPC_FOLLOWING_CONFIG,
  NPC_GROUP_DYNAMICS_CONFIG,
  NPC_POSTING_CONFIG,
  NPC_SOCIAL_ACTIONS_CONFIG,
  NPC_TICK_CONFIG,
  NPC_TRADING_CONFIG,
  type NPCActivityConfig,
  type NPCActivityPresetName,
} from "./npc-activity";
// RSS Sources: default feed URLs for bootstrap. WHY exported: same pattern as other engine config; allows tests or tooling to read the list without importing the bootstrap service.
export {
  DEFAULT_RSS_SOURCES,
  type RssSourceConfig,
} from "./rss-sources";
// Runtime Configuration (environment variables)
export {
  BLOCKCHAIN_CONFIG,
  createDeadline,
  ENV_CONFIG,
  GAME_TICK_CONFIG,
  getTimeRemaining,
  hasTimeRemaining,
  MARKET_DECISION_CONFIG,
  RUNTIME_CONFIG,
  SUB_MARKET_CONFIG,
  WORLD_FACTS_CONFIG,
} from "./runtime-config";

// Simulation Configuration
export {
  DEFAULT_SIMULATION_CONFIG,
  PREDICTION_TEMPLATES,
  SIMULATION_AGENT_NAMES,
  SIMULATION_CLUE_TEMPLATES,
  SIMULATION_COMPANIES,
  SIMULATION_QUESTIONS,
  SIMULATION_STRATEGIES,
  type SimulationStrategy,
} from "./simulation";
