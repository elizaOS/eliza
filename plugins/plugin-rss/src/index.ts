import type { Plugin } from '@elizaos/core';

// actions
import actGetFeed from "./actions/act_get_feed";
import actSubscribeFeed from "./actions/act_subscribe_feed";
import actUnsubscribeFeed from "./actions/act_unsubscribe_feed";
import actListFeeds from "./actions/act_list_feeds";

// providers
import { feeditemsProvider } from './providers/pvr_feeditems';

// Services
import { rssService } from './service';

// Types
export type {
  RssChannel,
  RssItem,
  RssFeed,
  FeedItemMetadata,
  FeedSubscriptionMetadata,
} from './types';

export { rssService };

/**
 * RSS Plugin Configuration
 * 
 * Environment Variables:
 * - RSS_FEEDS: JSON array or comma-separated list of feed URLs to auto-subscribe
 *   Example: RSS_FEEDS='["https://example.com/rss","https://news.com/feed"]'
 *   Example: RSS_FEEDS='https://example.com/rss,https://news.com/feed'
 * 
 * - RSS_DISABLE_ACTIONS: Set to "true" to disable subscription management actions
 *   When disabled, feeds can only be managed via RSS_FEEDS env var
 *   Default: false (actions are enabled)
 * 
 * - RSS_FEED_FORMAT: Output format for feed items in context
 *   Options: 'csv' (compact, token-efficient) or 'markdown' (human-readable)
 *   Default: 'csv' (recommended for economy)
 * 
 * - RSS_CHECK_INTERVAL_MINUTES: (Future) Check interval in minutes
 *   Default: 15 minutes
 *   Note: Currently hardcoded, will be configurable in future release
 */

// Check if subscription actions should be disabled
const actionsDisabled = process.env.RSS_DISABLE_ACTIONS === 'true';

// Build actions array conditionally
const actions = [
  actGetFeed, // Always include GET_NEWSFEED for initial setup
];

// Add subscription management actions if not disabled
if (!actionsDisabled) {
  actions.push(
    actSubscribeFeed,
    actUnsubscribeFeed,
    actListFeeds
  );
}

export const rssPlugin: Plugin = {
  name: 'rss',
  description: 'RSS/Atom feed monitoring and subscription management',
  evaluators: [],
  providers: [
    feeditemsProvider,
  ],
  actions,
  services: [rssService],
};

export default rssPlugin;

