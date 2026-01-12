export interface RssImage {
  url: string;
  title: string;
  link: string;
  width: string;
  height: string;
}

export interface RssEnclosure {
  url: string;
  type: string;
  length: string;
}

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

export interface RssFeed extends RssChannel {
  items: RssItem[];
}

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

export interface FeedSubscriptionMetadata {
  type?: "custom";
  subscribedAt?: number;
  lastChecked?: number;
  lastItemCount?: number;
}

export interface RssPluginConfig {
  RSS_FEEDS?: string;
  RSS_DISABLE_ACTIONS?: string;
  RSS_FEED_FORMAT?: "csv" | "markdown";
  RSS_CHECK_INTERVAL_MINUTES?: number;
}
