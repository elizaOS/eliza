/**
 * Moltbook Plugin Type Definitions
 * https://www.moltbook.com
 */

// =============================================================================
// API TYPES
// =============================================================================

/**
 * A Moltbook user profile
 */
export interface MoltbookProfile {
  id: string;
  username: string;
  displayName?: string;
  bio?: string;
  avatarUrl?: string;
  createdAt: string;
  followerCount: number;
  followingCount: number;
  postCount: number;
  isFollowing?: boolean;
}

/**
 * A Moltbook post (molty)
 */
export interface MoltbookPost {
  id: string;
  title: string;
  content: string;
  authorId: string;
  author: MoltbookProfile;
  submolt?: string;
  createdAt: string;
  updatedAt?: string;
  upvotes: number;
  downvotes: number;
  score: number;
  commentCount: number;
  url?: string;
}

/**
 * A comment on a post
 */
export interface MoltbookComment {
  id: string;
  postId: string;
  parentId?: string;
  content: string;
  authorId: string;
  author: MoltbookProfile;
  createdAt: string;
  upvotes: number;
  downvotes: number;
  score: number;
  replies?: MoltbookComment[];
}

/**
 * A submolt (community/subreddit equivalent)
 */
export interface MoltbookSubmolt {
  id: string;
  name: string;
  description?: string;
  memberCount: number;
  postCount: number;
  createdAt: string;
  rules?: string[];
}

/**
 * Feed response from API
 */
export interface MoltbookFeed {
  posts: MoltbookPost[];
  hasMore: boolean;
  cursor?: string;
}

/**
 * Search result item (post or comment)
 */
export interface MoltbookSearchResult {
  id: string;
  type: "post" | "comment";
  title: string | null;
  content: string;
  upvotes: number;
  downvotes: number;
  created_at: string;
  similarity: number;
  author: { name: string };
  submolt?: { name: string; display_name: string };
  post_id: string;
  post?: { id: string; title: string };
}

/**
 * Search results from semantic search API
 */
export interface MoltbookSearchResults {
  success: boolean;
  query: string;
  type: string;
  results: MoltbookSearchResult[];
  count: number;
}

// =============================================================================
// CREDENTIAL TYPES
// =============================================================================

/**
 * Stored credentials for a Moltbook account
 */
export interface MoltbookCredentials {
  apiKey: string;
  userId: string;
  username: string;
  registeredAt: number;
  claimStatus?: "unclaimed" | "claimed";
  claimUrl?: string;
}

// =============================================================================
// RATE LIMITING TYPES
// =============================================================================

/**
 * Rate limit state per agent
 */
export interface RateLimitState {
  requests: { timestamp: number }[];
  posts: { timestamp: number }[];
  comments: { timestamp: number }[];
  retryAfter?: number;
}

/**
 * Per-agent state including rate limits and cache
 */
export interface AgentMoltbookState {
  credentials?: MoltbookCredentials;
  rateLimits: RateLimitState;
  feedCache?: CachedData<MoltbookFeed>;
  profileCache?: CachedData<MoltbookProfile>;
}

// =============================================================================
// CACHE TYPES
// =============================================================================

/**
 * Cached data with freshness tracking
 */
export interface CachedData<T> {
  data: T;
  fetchedAt: number;
}

/**
 * Cache options for fetch operations
 */
export interface CacheOptions {
  /** Maximum age in milliseconds */
  maxAge?: number;
  /** Require data newer than this timestamp */
  newerThan?: number;
  /** Force fresh fetch, bypass cache */
  forceFresh?: boolean;
}

// =============================================================================
// INTELLIGENCE TYPES
// =============================================================================

/**
 * Community analysis results
 */
export interface CommunityContext {
  /** Hot topics being discussed */
  activeTopics: string[];
  /** Posts worth engaging with */
  engagementOpportunities: EngagementOpportunity[];
  /** Posting patterns that work well */
  whatWorks: string[];
  /** Notable community members */
  notableMoltys: MoltbookProfile[];
  /** Overall community vibe */
  vibe: string;
  /** When this analysis was generated */
  analyzedAt: number;
}

/**
 * A specific engagement opportunity
 */
export interface EngagementOpportunity {
  post: MoltbookPost;
  reason: string;
  type: "comment" | "upvote" | "follow";
  priority: number;
}

// =============================================================================
// QUALITY GATE TYPES
// =============================================================================

/**
 * Quality assessment criteria
 */
export interface QualityScore {
  relevance: number; // 1-10: Is this relevant to the community?
  interestingness: number; // 1-10: Would someone want to read this?
  originality: number; // 1-10: Is this a fresh perspective?
  voice: number; // 1-10: Does it sound like the character?
  value: number; // 1-10: Does it add value to the conversation?
  overall: number; // Average of all scores
  feedback: string; // Specific improvement suggestions
  pass: boolean; // Meets minimum threshold
}

/**
 * Content to be judged
 */
export interface ContentToJudge {
  title?: string;
  content: string;
  context?: string;
  isComment?: boolean;
}

// =============================================================================
// SERVICE TYPES
// =============================================================================

/**
 * Service configuration
 */
export interface MoltbookConfig {
  /** Base API URL */
  apiUrl: string;
  /** Auto-register if no credentials */
  autoRegister: boolean;
  /** Enable autonomous posting */
  autoEngage: boolean;
  /** Minimum quality score to post (1-10) */
  minQualityScore: number;
  /** Maximum retries for composition */
  maxComposeRetries: number;
}

/**
 * Memory table names used by the plugin
 */
export const MEMORY_TABLES = {
  CREDENTIALS: "moltbook_credentials",
  POSTS_SEEN: "moltbook_posts_seen",
  INTERACTIONS: "moltbook_interactions",
  MOLTYS: "moltbook_moltys",
} as const;

/**
 * Memory metadata for credential storage
 */
export interface CredentialMemoryMetadata {
  type: "moltbook_credentials";
  credentials: MoltbookCredentials;
  [key: string]: unknown;
}

/**
 * Memory metadata for seen posts
 */
export interface PostSeenMemoryMetadata {
  type: "moltbook_post_seen";
  postId: string;
  seenAt: number;
  engaged: boolean;
  engagementType?: "upvote" | "downvote" | "comment";
  [key: string]: unknown;
}

/**
 * Memory metadata for interactions
 */
export interface InteractionMemoryMetadata {
  type: "moltbook_interaction";
  postId?: string;
  commentId?: string;
  interactionType: "post" | "comment" | "vote" | "follow";
  content?: string;
  createdAt: number;
  [key: string]: unknown;
}

// =============================================================================
// NEW: Types from next branch for enhanced functionality
// =============================================================================

/**
 * Moltbook service settings from environment/character config
 */
export interface MoltbookSettings {
  /** Agent display name */
  agentName: string;
  /** Moltbook API token for social engagement */
  moltbookToken?: string;
  /** LLM API key (OpenRouter) */
  llmApiKey?: string;
  /** LLM base URL */
  llmBaseUrl?: string;
  /** LLM model identifier */
  model?: string;
  /** Agent personality/system prompt extension */
  personality?: string;
  /** Autonomy loop interval in ms */
  autonomyIntervalMs?: number;
  /** Maximum autonomy steps before stopping */
  autonomyMaxSteps?: number;
  /** Whether to run in autonomous mode */
  autonomousMode?: boolean;
}

/**
 * Event types emitted by the Moltbook service
 */
export const MoltbookEventTypes = {
  POST_CREATED: "moltbook.post.created",
  COMMENT_CREATED: "moltbook.comment.created",
  POSTS_BROWSED: "moltbook.posts.browsed",
  POST_READ: "moltbook.post.read",
  AUTONOMY_STEP_COMPLETED: "moltbook.autonomy.step.completed",
  AUTONOMY_STARTED: "moltbook.autonomy.started",
  AUTONOMY_STOPPED: "moltbook.autonomy.stopped",
} as const;

export type MoltbookEventType = (typeof MoltbookEventTypes)[keyof typeof MoltbookEventTypes];

/**
 * Payload for post events
 */
export interface MoltbookPostPayload {
  postId: string;
  submolt: string;
  title: string;
}

/**
 * Payload for comment events
 */
export interface MoltbookCommentPayload {
  commentId: string;
  postId: string;
  parentId?: string;
}

/**
 * Payload for autonomy step events
 */
export interface MoltbookAutonomyStepPayload {
  stepNumber: number;
  action: string;
  result: string;
  timestamp: string;
}

/**
 * Result type for API operations that can fail
 * Prevents silent failures by making errors explicit
 */
export type MoltbookResult<T> =
  | { success: true; data: T; error?: undefined }
  | { success: false; error: string; data?: undefined };

/**
 * Helper to create a successful result
 */
export function moltbookSuccess<T>(data: T): MoltbookResult<T> {
  return { success: true, data };
}

/**
 * Helper to create a failed result
 */
export function moltbookFailure<T>(error: string): MoltbookResult<T> {
  return { success: false, error };
}

/**
 * IMoltbookService interface for type-safe service access
 * Core methods from consolidated 1.x + next implementation
 */
export interface IMoltbookService {
  /** Service type identifier */
  readonly serviceType: string;
  /** Create a post */
  createPost(title: string, content: string, submolt?: string): Promise<MoltbookPost | null>;
  /** Create a comment or reply */
  createComment(
    postId: string,
    content: string,
    parentId?: string
  ): Promise<MoltbookComment | null>;
  /** Get posts feed */
  getPosts(options?: any): Promise<MoltbookFeed | null>;
  /** Get a single post */
  getPost(postId: string): Promise<MoltbookPost | null>;
  /** Get comments for a post */
  getComments(postId: string): Promise<MoltbookComment[]>;
  /** Get all submolts */
  getSubmolts(sort?: string): Promise<MoltbookSubmolt[] | null>;
  /** Get a specific submolt */
  getSubmolt(name: string): Promise<MoltbookSubmolt | null>;
  /** Start autonomous loop */
  startAutonomyLoop(): void;
  /** Stop autonomous loop */
  stopAutonomyLoop(): void;
  /** Check if autonomy is running */
  isAutonomyRunning(): boolean;
}
