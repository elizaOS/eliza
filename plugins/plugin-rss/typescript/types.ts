/**
 * RSS Plugin Type Definitions
 */

/**
 * RSS Image metadata
 */
export interface RssImage {
  url: string;
  title: string;
  link: string;
  width: string;
  height: string;
}

/**
 * RSS Enclosure (media attachment)
 */
export interface RssEnclosure {
  url: string;
  type: string;
  length: string;
}

/**
 * RSS Channel metadata
 */
export interface RssChannel {
  title: string;
  description: string;
  link: string;
  language: string;
  copyright: string;
  lastBuildDate: string;
  generator: string;
  docs: string;
  ttl: string;
  image: RssImage | null;
}

/**
 * RSS Item (article/post)
 */
export interface RssItem {
  title: string;
  link: string;
  pubDate: string;
  description: string;
  author: string;
  category: string[];
  comments: string;
  guid: string;
  enclosure: RssEnclosure | null;
}

/**
 * Complete RSS Feed (channel + items)
 */
export interface RssFeed extends RssChannel {
  items: RssItem[];
}

/**
 * Feed Item Metadata stored in memory
 */
export interface FeedItemMetadata {
  title?: string;
  description?: string;
  pubDate?: string;
  author?: string;
  feedUrl?: string;
  feedTitle?: string;
  link?: string;
  category?: string[];
  type?: string;
}

/**
 * Feed Subscription Metadata stored in memory
 */
export interface FeedSubscriptionMetadata {
  type: 'custom';
  subscribedAt: number;
  lastChecked: number;
  lastItemCount: number;
  [key: string]: unknown;
}

/**
 * RSS Plugin Configuration
 */
export interface RssPluginConfig {
  /** JSON array or comma-separated list of feed URLs to auto-subscribe */
  RSS_FEEDS?: string;
  /** Set to "true" to disable subscription management actions */
  RSS_DISABLE_ACTIONS?: string;
  /** Output format: 'csv' (compact) or 'markdown' (readable) */
  RSS_FEED_FORMAT?: 'csv' | 'markdown';
  /** Check interval in minutes */
  RSS_CHECK_INTERVAL_MINUTES?: number;
}

