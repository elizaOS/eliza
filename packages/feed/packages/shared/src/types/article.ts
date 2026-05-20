/**
 * Shared Article Types
 *
 * Single source of truth for all article-related types across the codebase.
 * These types are used by both the engine (ArticleGenerator, persistence)
 * and frontend components (ArticleCard, LatestNewsPanel, etc.)
 *
 * @module types/article
 */

/**
 * Core article type - used by ArticleGenerator and persistence
 *
 * Represents a fully-generated article with all metadata.
 * This is the output from ArticleGenerator.
 */
export interface Article {
  /** Unique article ID (snowflake) */
  id: string;
  /** Article headline */
  title: string;
  /** 2-3 sentence summary for social feeds */
  summary: string;
  /** Full article body (800-1500 words) */
  content: string;
  /** ID of the news organization that authored the article */
  authorOrgId: string;
  /** Display name of the authoring organization */
  authorOrgName: string;
  /** Optional journalist byline */
  byline?: string;
  /** Actor ID of the journalist (if applicable) */
  bylineActorId?: string;
  /** Bias score from -1 (critical) to +1 (protective) */
  biasScore?: number;
  /** Overall article sentiment */
  sentiment?: 'positive' | 'negative' | 'neutral';
  /** Editorial slant/angle description */
  slant?: string;
  /** Cover image URL */
  imageUrl?: string;
  /** Related world event ID */
  relatedEventId?: string;
  /** Related prediction market question number */
  relatedQuestion?: number;
  /** IDs of actors mentioned in the article */
  relatedActorIds: string[];
  /** IDs of organizations mentioned in the article */
  relatedOrgIds: string[];
  /** Article category (e.g., 'tech', 'scandal', 'finance') */
  category?: string;
  /** SEO/filtering tags */
  tags: string[];
  /** Publication timestamp */
  publishedAt: Date;
}

/**
 * Input for creating/persisting articles to the database
 *
 * Used by the article-persistence service and other article creation points.
 * Fields are mapped to the posts table schema.
 */
export interface ArticlePersistInput {
  /** Optional article ID - will generate if not provided */
  id?: string;
  /** Article headline */
  title: string;
  /** 2-3 sentence summary (stored in posts.content) */
  summary: string;
  /** Full article body (stored in posts.fullContent) */
  content: string;
  /** ID of the authoring organization (stored in posts.authorId) */
  authorOrgId: string;
  /** Game ID for the article */
  gameId: string;
  /** Current game day number */
  dayNumber?: number;
  /** Optional journalist byline */
  byline?: string;
  /** Bias score (-1 to +1) */
  biasScore?: number;
  /** Article sentiment */
  sentiment?: 'positive' | 'negative' | 'neutral';
  /** Editorial slant description */
  slant?: string;
  /** Article category */
  category?: string;
  /** Cover image URL (usually generated asynchronously) */
  imageUrl?: string;
  /** Related prediction market question number */
  relatedQuestion?: number;
  /** Publication timestamp (defaults to now) */
  timestamp?: Date;
}

/**
 * Lightweight article type for UI display
 *
 * Used by frontend components like LatestNewsPanel and MoreArticlesWidget.
 * Contains only the fields needed for article previews and cards.
 */
export interface ArticleItem {
  /** Unique article ID */
  id: string;
  /** Article headline */
  title: string;
  /** Summary for display */
  summary: string;
  /** Display name of the authoring organization */
  authorOrgName: string;
  /** Optional journalist byline */
  byline?: string;
  /** Article sentiment (for display styling) - matches Article.sentiment type */
  sentiment?: 'positive' | 'negative' | 'neutral';
  /** Article category (for filtering/display) */
  category?: string;
  /** Publication timestamp as ISO string */
  publishedAt: string;
  /** Related prediction market question number */
  relatedQuestion?: number;
  /** Editorial slant description */
  slant?: string;
  /** Bias score for display */
  biasScore?: number;
}

/**
 * Article preview for sidebar widgets
 *
 * Minimal article data for "More Articles" type widgets.
 * Derived from ArticleItem with imageUrl added.
 */
export type ArticlePreview = Pick<
  ArticleItem,
  'id' | 'title' | 'summary' | 'authorOrgName' | 'publishedAt'
> & {
  /** Cover image URL (may be null if not generated) */
  imageUrl: string | null;
};
