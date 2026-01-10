/**
 * RSS Plugin Type Definitions
 */

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
  image: {
    url: string;
    title: string;
    link: string;
    width: string;
    height: string;
  } | null;
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
  enclosure: {
    url: string;
    type: string;
    length: string;
  } | null;
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
  type: 'feed_subscription';
  subscribedAt: number;
  lastChecked: number;
  lastItemCount: number;
  [key: string]: unknown;
}

