/**
 * Narrative Feed Types
 *
 * Single source of truth for narrative feed API response shapes.
 * Consumed by both the API route (apps/web/src/app/api/feed/narrative/route.ts)
 * and frontend feed components.
 *
 * ArcStateType mirrors the union defined in @feed/db/src/schema/narrative.ts.
 * The db schema definition is the canonical one; keep this copy in sync with it.
 */

/**
 * Arc state for a prediction market question.
 * Covers all market durations (long-term, weekly, daily, intraday, flash).
 */
export type ArcStateType =
  | 'setup'
  | 'tension'
  | 'escalation'
  | 'crisis'
  | 'revelation'
  | 'resolution'
  | 'resolving'
  | 'active'
  | 'climax'
  | 'live'
  | 'morning'
  | 'midday'
  | 'afternoon'
  | 'evening';

/**
 * A single post within a narrative story group.
 * Matches the shape returned by GET /api/feed/narrative.
 */
export interface NarrativePost {
  id: string;
  content: string;
  fullContent: string | null;
  articleTitle: string | null;
  category: string | null;
  imageUrl: string | null;
  type: string | null;
  timestamp: string;
  authorId: string;
  authorName: string;
  authorUsername: string | null;
  authorProfileImageUrl: string | null;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  isLiked: boolean;
  isShared: boolean;
  relatedQuestion: number | null;
  /**
   * Content-type classification derived from StaticDataRegistry lookups in the
   * narrative route. Used by applySlotPattern() to enforce feed diversity:
   * - 'actor': individual NPC personality (e.g. Tim PAIl, Ben HorowAItz)
   * - 'news': news/media org NPC (e.g. AIxios, ForbesAI, WAIred)
   * - 'user': real platform user
   */
  authorType?: 'actor' | 'news' | 'user';
  // Repost fields — mirrors the shape PostCard expects
  isRepost?: boolean;
  isQuote?: boolean;
  quoteComment?: string | null;
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
}

/**
 * A narrative story — posts grouped by prediction market question,
 * scored by the narrative engine (engagement × arc state × resolution proximity).
 * Matches the shape returned by GET /api/feed/narrative.
 *
 * When `isNewMarket` is true the story represents a freshly opened prediction
 * market question (no or very few posts yet). The feed renders a dedicated
 * NewMarketCard with a "Trade" CTA instead of the normal story layout.
 */
export interface NarrativeStory {
  storyKey: string;
  storyTitle: string;
  questionNumber: number | null;
  arcState: ArcStateType | null;
  storyScore: number;
  finalRankScore?: number;
  postCount: number;
  posts: NarrativePost[];
  hasUserPosition: boolean;
  clusterId?: string;
  rootMarketId?: string | null;
  primaryAuthorId?: string | null;
  topicKey?: string | null;
  topicLabel?: string | null;
  itemType?: 'post' | 'article' | 'market';
  isCarryover?: boolean;
  /** True when this entry is a newly-opened market (< 24h), not a post group */
  isNewMarket?: boolean;
  /** ISO-8601 resolution deadline, present when isNewMarket is true */
  resolutionDate?: string;
  /** Market UUID for deep-linking to /markets/predictions/[marketId] */
  marketId?: string | null;
  /** Live YES share count from the markets table (0 = new market at 50% parity) */
  yesShares?: number;
  /** Live NO share count from the markets table (0 = new market at 50% parity) */
  noShares?: number;
  /**
   * ID of an NPC post about this market, used to anchor InteractionBar
   * (like/comment/share) on NewMarketCard. Set when a matching NPC post exists
   * but is filtered from the feed to avoid duplication with the card itself.
   */
  anchorPostId?: string | null;
  /** True when this market card represents a recently resolved market */
  isResolved?: boolean;
  /** Resolution outcome for resolved markets (true = YES, false = NO, null = expired/unresolved) */
  resolvedOutcome?: boolean | null;
}

export type FeedSurface =
  | 'for_you'
  | 'following'
  | 'trades'
  | 'latest'
  | 'hot'
  | 'stories';

export type FeedEventAction =
  | 'impression'
  | 'visible_2s'
  | 'open_post'
  | 'open_article'
  | 'open_market'
  | 'like'
  | 'share'
  | 'comment'
  | 'follow'
  | 'hide'
  | 'trade_after_view';

export interface FeedEventPayload {
  actionType: FeedEventAction;
  surface: FeedSurface;
  itemId: string;
  itemType: 'post' | 'article' | 'market';
  clusterId?: string | null;
  marketId?: string | null;
  topicKey?: string | null;
  authorId?: string | null;
  feedPosition?: number;
  dwellMs?: number;
}
