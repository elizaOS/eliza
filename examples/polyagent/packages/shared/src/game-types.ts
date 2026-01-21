/**
 * Shared Type Definitions for Polyagent Game
 *
 * Centralized TypeScript types to eliminate duplication and ensure consistency
 */

import type { ACTOR_TIERS, POST_TYPES, RELATIONSHIP_TYPES } from "./constants";

/**
 * Actor tier type from constants
 */
export type ActorTier = (typeof ACTOR_TIERS)[keyof typeof ACTOR_TIERS];

/**
 * Post type from constants
 */
export type PostType = (typeof POST_TYPES)[keyof typeof POST_TYPES];

/**
 * OrgType is exported from constants.ts to avoid duplicate exports
 */

/**
 * Core Actor data structure
 * Used across all game systems
 */
export interface Actor {
  id: string;
  name: string;
  description?: string;
  profileDescription?: string; // What the actor says about themselves on their profile
  domain?: string[];
  personality?: string;
  voice?: string; // HOW they speak - verbal patterns, tone, sentence structure
  role?: string;
  affiliations?: string[]; // Organization IDs
  postStyle?: string; // Style guide for how they write posts
  postExample?: string[]; // Example posts demonstrating their voice
  tier?: ActorTier;

  // Content relevance filtering
  /** Topics this actor explicitly ignores (won't post about these) */
  ignoreTopics?: string[];
  /** Minimum engagement threshold (0-1) for off-domain topics. Default: 0.5 */
  engagementThreshold?: number;

  // Database-specific fields (optional, populated when stored in DB)
  initialLuck?: "low" | "medium" | "high";
  initialMood?: number; // -1 to 1
  hasPool?: boolean; // Can run a trading pool
  tradingBalance?: number; // NPC's trading balance
  reputationPoints?: number; // Reputation points for leaderboard
  profileImageUrl?: string; // Actor profile image

  // NPC Persona (for consistency and learnability)
  persona?: {
    reliability: number; // 0-1, how often tells truth
    insiderOrgs: string[]; // Org IDs with insider knowledge
    expertise: string[]; // Domain expertise
    willingToLie: boolean; // Will strategically deceive
    selfInterest: "wealth" | "reputation" | "ideology" | "chaos";
    favorsActors: string[]; // Actor IDs they favor
    opposesActors: string[]; // Actor IDs they oppose
    favorsOrgs: string[]; // Org IDs they favor
    opposesOrgs: string[]; // Org IDs they oppose
  };

  // Track record (updated as game progresses)
  trackRecord?: {
    totalPosts: number;
    accuratePosts: number;
    historicalAccuracy: number; // accuratePosts / totalPosts
  };
}

/**
 * Extended actor with game state
 * Used during game generation and simulation
 */
export interface SelectedActor extends Actor {
  tier: ActorTier;
  role: string;
  initialLuck: "low" | "medium" | "high";
  initialMood: number; // -1 to 1
}

/**
 * Actor runtime state
 * Tracks mood and luck during game progression
 */
export interface ActorState {
  mood: number; // -1 to 1
  luck: "low" | "medium" | "high";
}

/**
 * Relationship type (re-exported from constants)
 */
export type RelationshipType =
  (typeof RELATIONSHIP_TYPES)[keyof typeof RELATIONSHIP_TYPES];

/**
 * Rich relationship data between two actors
 */
export interface ActorRelationship {
  id: string;
  actor1Id: string;
  actor2Id: string;
  relationshipType: RelationshipType;
  strength: number; // 0.0 to 1.0
  sentiment: number; // -1.0 to 1.0
  isPublic: boolean;
  history?: string;
  affects?: Record<string, number>; // Behavioral modifiers
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Actor follow relationship
 */
export interface ActorFollow {
  id: string;
  followerId: string;
  followingId: string;
  isMutual: boolean;
  createdAt: Date;
}

/**
 * Simple connection between actors (used in game setup)
 * For richer relationships with persistence, use ActorRelationship instead
 */
export interface ActorConnection {
  actor1: string;
  actor2: string;
  relationship: string;
  context: string;
}

/**
 * Stock price at a specific moment
 */
export interface StockPrice {
  price: number;
  timestamp: string; // ISO timestamp
  change: number; // Change from previous price
  changePercent: number; // Percentage change
}

/**
 * Price update with reason
 */
export interface PriceUpdate {
  organizationId: string;
  timestamp: string;
  oldPrice: number;
  newPrice: number;
  change: number;
  changePercent: number;
  reason: string; // Event that caused the change
  impact: "major" | "moderate" | "minor"; // Magnitude of impact
}

/**
 * Markov chain state for price generation
 */
export interface MarkovChainState {
  trend: "bullish" | "bearish" | "neutral";
  volatility: number; // 0-1
  momentum: number; // -1 to 1
}

/**
 * Organization entity
 */
export interface Organization {
  id: string;
  name: string;
  ticker?: string; // 4-6 character trading ticker (e.g., METAI, NVDAI, AINDRL)
  description: string;
  profileDescription?: string; // What the organization says about itself on its profile
  type:
    | "company"
    | "media"
    | "government"
    | "vc"
    | "organization"
    | "financial";
  canBeInvolved: boolean;
  postStyle?: string;
  postExample?: string[];
  // Stock price fields (only for companies)
  initialPrice?: number; // Starting price
  currentPrice?: number; // Current price
  priceHistory?: StockPrice[]; // Historical prices
  markovState?: MarkovChainState; // Current market state
  // Name replacement fields (for data files)
  originalName?: string; // For name replacement
  originalHandle?: string; // For name replacement
  username?: string; // Organization username/handle
  pfpDescription?: string; // For image generation only
  bannerDescription?: string; // For image generation only
}

/**
 * Feed post (social media post)
 */
export interface FeedPost {
  id: string;
  day?: number;
  timestamp: string;
  createdAt?: string;
  type?: PostType;
  content: string;
  fullContent?: string | null;
  articleTitle?: string | null;
  byline?: string | null;
  biasScore?: number | null;
  sentiment?: number | null; // -1 to 1
  slant?: string | null;
  category?: string | null;
  tags?: string[]; // Topic tags for trending detection
  author: string;
  authorId?: string;
  authorName: string;
  authorUsername?: string | null;
  authorProfileImageUrl?: string | null;
  replyTo?: string;
  relatedQuestion?: number; // Prediction market question ID
  /**
   * Related event is kept in-memory during generation but NOT persisted
   * or exposed to agents. Used for offline RL training only.
   */
  relatedEvent?: string | null;
  gameId?: string | null;
  dayNumber?: number | null;
  clueStrength?: number; // 0-1 (how much this reveals)
  pointsToward?: boolean | null; // Does this hint at YES or NO?
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  isLiked?: boolean;
  isShared?: boolean;
  // Repost metadata
  isRepost?: boolean;
  isQuote?: boolean; // True if it has quote commentary
  quoteComment?: string | null; // The quote commentary text
  originalPostId?: string | null;
  originalPost?: {
    id: string;
    content: string;
    authorId: string;
    authorName: string;
    authorUsername: string | null;
    authorProfileImageUrl: string | null;
    timestamp: string;
  } | null;
  // Flat fields for original post metadata (alternative to nested originalPost object)
  originalAuthorId?: string | null;
  originalAuthorName?: string | null;
  originalAuthorUsername?: string | null;
  originalAuthorProfileImageUrl?: string | null;
  originalContent?: string | null;
}

/**
 * Alias for backwards compatibility
 */
export type FeedEvent = FeedPost;

/**
 * World event (things that happen in the game world)
 */
export interface WorldEvent {
  id: string;
  day: number;
  type:
    | "announcement"
    | "meeting"
    | "leak"
    | "development"
    | "scandal"
    | "rumor"
    | "deal"
    | "conflict"
    | "revelation"
    | "development:occurred"
    | "news:published";
  actors: string[];
  description: string;
  relatedQuestion?: number | null;
  /**
   * @deprecated Use sentimentSignal instead for more nuanced signal direction.
   * Kept for backwards compatibility - will be derived from sentimentSignal if not set.
   */
  pointsToward?: "YES" | "NO" | null;
  visibility: "public" | "leaked" | "secret" | "private" | "group";

  // New sentiment-based signal fields (preferred over pointsToward)
  /** Sentiment signal from -1.0 (negative) to 1.0 (positive) */
  sentimentSignal?: number;
  /** How clear/strong the signal is (0 to 1) */
  signalClarity?: number;
  /** Reliability of the source (0 to 1) */
  sourceReliability?: number;
}

/**
 * Scenario for prediction market
 */
export interface Scenario {
  id: number;
  title: string;
  description: string;
  mainActors: string[];
  involvedOrganizations?: string[];
  theme: string;
}

/**
 * Eliza Character Message Example
 * Used in character files for AI agent conversation training
 */
export interface ElizaMessageExample {
  user: string;
  content: {
    text: string;
    action?: string;
  };
}

/**
 * Eliza Character Definition
 * Full character configuration for AI agents
 */
export interface ElizaCharacter {
  name: string;
  username: string;
  bio: string[];
  lore: string[];
  messageExamples: ElizaMessageExample[][]; // Array of conversation arrays
  postExamples: string[];
  topics: string[];
  adjectives: string[];
  style: {
    all: string[];
    chat: string[];
    post: string[];
  };
  clients: string[];
  plugins?: string[];
  modelProvider?: string;
  settings?: {
    secrets?: Record<string, string>;
    voice?: {
      model: string;
    };
    strategies?: string[];
    riskTolerance?: number;
    minConfidence?: number;
    autoTrading?: boolean;
  };
}

/**
 * Extended Actor definition for data files
 * Includes all fields from individual actor TypeScript files
 * (stored in packages/engine/src/data/actors/*.ts)
 */
export interface ActorData extends Actor {
  realName: string;
  username: string;
  pfpDescription?: string; // For image generation only
  profileBanner?: string; // For image generation only
  originalFirstName: string; // For name replacement
  originalLastName: string; // For name replacement
  originalHandle: string; // For name replacement
  firstName?: string; // Current first name (for name replacement)
  lastName?: string; // Current last name (for name replacement)
}

/**
 * Database seed data structure
 * Used in src/db/seed.ts for seeding the database
 * This extends the basic ActorsDatabase with additional seed-specific requirements
 */
export interface SeedActorsDatabase {
  actors: ActorData[];
  organizations: Organization[];
  relationships?: Array<{
    actor1Id: string;
    actor2Id: string;
    relationshipType: string;
    strength: number;
    sentiment: number;
    history: string;
    actor1FollowsActor2: boolean;
    actor2FollowsActor1: boolean;
  }>;
}

/**
 * Question for prediction market
 */
export interface Question {
  id: number | string; // Can be number or string (database uses string IDs)
  text: string;
  scenario: number;
  outcome: boolean;
  rank: number;
  // New fields for continuous game
  createdDate?: string; // ISO date when question was created
  resolutionDate?: string; // ISO date when question resolves (24h-7d from creation)
  status?: "active" | "resolved" | "cancelled"; // Question lifecycle status
  resolvedOutcome?: boolean; // Final outcome when resolved
  resolutionProofUrl?: string; // URL to post/article proving outcome
  resolutionDescription?: string; // Description of how it resolved
  timeframe?: string; // Timeframe category (e.g., '24h', '7d', '30d')
  // Database fields
  questionNumber?: number; // Question number for tracking
  createdAt?: Date | string; // Database timestamp
  updatedAt?: Date | string; // Database timestamp
  scenarioId?: number; // Alternative scenario field name
  // Arc planning metadata (for learnability)
  metadata?: {
    arcPlan?: {
      uncertaintyPeakDay: number;
      clarityOnsetDay: number;
      verificationDay: number;
      insiders: string[];
      deceivers: string[];
    };
  };
}

/**
 * Group chat configuration
 */
export interface GroupChat {
  id: string;
  name: string;
  admin: string;
  members: string[];
  theme: string;
}

/**
 * Chat message in group chat (for game generation/timeline)
 * Note: This is different from the system ChatMessage used in useChatMessages
 */
export interface GroupChatMessage {
  from: string;
  message: string;
  timestamp: string;
  clueStrength: number; // 0-1
}

/**
 * Luck change event
 */
export interface LuckChange {
  actor: string;
  from: string;
  to: string;
  reason: string;
}

/**
 * Mood change event
 */
export interface MoodChange {
  actor: string;
  from: number;
  to: number;
  reason: string;
}

/**
 * Day timeline (single day in game)
 */
export interface DayTimeline {
  day: number;
  summary: string;
  events: WorldEvent[];
  groupChats: Record<string, GroupChatMessage[]>;
  feedPosts: FeedPost[];
  luckChanges: LuckChange[];
  moodChanges: MoodChange[];
}

/**
 * Question outcome at game resolution
 */
export interface QuestionOutcome {
  questionId: number | string; // Can be number or string to match Question.id
  answer: boolean;
  explanation: string;
  keyEvents: string[];
}

/**
 * Game resolution (final state)
 */
export interface GameResolution {
  day: 30;
  outcomes: QuestionOutcome[];
  finalNarrative: string;
}

/**
 * Game setup configuration
 */
export interface GameSetup {
  mainActors: SelectedActor[];
  supportingActors: SelectedActor[];
  extras: SelectedActor[];
  organizations: Organization[];
  scenarios: Scenario[];
  questions: Question[];
  groupChats: GroupChat[];
  connections: ActorConnection[];
}

/**
 * Game state for continuous generation
 */
export interface GameState {
  id: string;
  currentDay: number;
  currentDate: string; // ISO date
  activeQuestions: Question[]; // Currently active questions (max 20)
  resolvedQuestions: Question[]; // Questions that have been resolved
  organizations: Organization[]; // Organizations with current prices
  priceUpdates: PriceUpdate[]; // Recent price updates
  lastGeneratedDate: string; // ISO timestamp of last generation
}

/**
 * Complete generated game
 */
export interface GeneratedGame {
  id: string;
  version: string;
  generatedAt: string;
  setup: GameSetup;
  timeline: DayTimeline[];
  resolution: GameResolution;
  // New fields for continuous game
  gameState?: GameState; // Current game state (for continuous games)
}

/**
 * Actors database structure
 * Used for loading actor/organization data from TypeScript files
 * - Individual files in packages/engine/src/data/actors/*.ts
 * - Individual files in packages/engine/src/data/organizations/*.ts
 * - Loaded via loadActorsData() utility (direct TypeScript imports)
 */
export interface ActorsDatabase {
  actors: ActorData[];
  organizations: Organization[];
  relationships?: Array<{
    actor1Id: string;
    actor2Id: string;
    relationshipType: string;
    strength: number;
    sentiment: number;
    history: string;
    actor1FollowsActor2: boolean;
    actor2FollowsActor1: boolean;
  }>;
}

/**
 * Game history summary (for context in subsequent games)
 */
export interface GameHistory {
  gameNumber: number;
  completedAt: string;
  summary: string;
  keyOutcomes: {
    questionText: string;
    outcome: boolean;
    explanation: string;
  }[];
  highlights: string[];
  topMoments: string[];
}

/**
 * Genesis game (initial 7-day game)
 */
export interface GenesisGame {
  id: string;
  version: string;
  generatedAt: string;
  dateRange: {
    start: string; // "2025-10-24"
    end: string; // "2025-10-31"
  };
  actors: SelectedActor[];
  timeline: DayTimeline[];
  summary: string;
}
