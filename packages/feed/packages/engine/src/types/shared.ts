/**
 * Shared Type Definitions for Feed Game Engine
 *
 * Re-exports from @feed/shared for convenience, plus engine-specific types
 */

// Re-export all types from @feed/shared
export type {
  Actor,
  ActorConnection,
  ActorData,
  ActorFollow,
  ActorRelationship,
  ActorState,
  ActorsDatabase,
  ActorTier,
  DayTimeline,
  ElizaCharacter,
  ElizaMessageExample,
  FeedEvent,
  FeedPost,
  GameHistory,
  GameResolution,
  GameSetup,
  GameState,
  GeneratedGame,
  GenesisGame,
  GroupChat,
  GroupChatMessage as ChatMessage,
  GroupChatMessage,
  LuckChange,
  MarkovChainState,
  MoodChange,
  Organization,
  OrgType,
  PostType,
  PriceUpdate,
  Question,
  QuestionOutcome,
  RelationshipType,
  Scenario,
  SeedActorsDatabase,
  SelectedActor,
  StockPrice,
  WorldEvent,
} from "@feed/shared";

// Re-export all constants from @feed/shared
export {
  ACTOR_COUNTS,
  ACTOR_TIERS,
  DAY_RANGES,
  FEED_TARGETS,
  FEED_WIDGET_CONFIG,
  GAME_STRUCTURE,
  getEscalationLevel,
  ORG_TYPES,
  POST_TYPES,
  RELATIONSHIP_TYPES,
} from "@feed/shared";

// NOTE: WorldContext removed - use WorldFactsContext from world-facts-service.ts
// or WorldContext from prompts/world-context.ts depending on use case
