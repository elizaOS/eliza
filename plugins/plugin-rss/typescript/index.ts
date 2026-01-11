/**
 * RSS Plugin for elizaOS
 *
 * Provides RSS/Atom feed monitoring and subscription management capabilities.
 *
 * Features:
 * - Feed fetching and parsing
 * - Feed subscriptions
 * - Periodic feed checking
 * - Duplicate detection
 * - Multiple output formats (CSV/Markdown)
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

// Actions
import {
  getFeedAction,
  listFeedsAction,
  subscribeFeedAction,
  unsubscribeFeedAction,
} from "./actions";

// Providers
import { feedItemsProvider } from "./providers";

// Service
import { RssService } from "./service";

// Re-export parser utilities
export { createEmptyFeed, parseRssToJson } from "./parser";

// Re-export service
export { RssService, RssService as rssService } from "./service";
// Re-export types
export type {
  FeedItemMetadata,
  FeedSubscriptionMetadata,
  RssChannel,
  RssEnclosure,
  RssFeed,
  RssImage,
  RssItem,
  RssPluginConfig,
} from "./types";

// Re-export utilities
export { createMessageReply, extractUrls, formatRelativeTime } from "./utils";

// Check if subscription actions should be disabled
const actionsDisabled = process.env.RSS_DISABLE_ACTIONS === "true";

// Build actions array conditionally
const actions = [
  getFeedAction, // Always include GET_NEWSFEED for initial setup
];

// Add subscription management actions if not disabled
if (!actionsDisabled) {
  actions.push(subscribeFeedAction, unsubscribeFeedAction, listFeedsAction);
}

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
 * - RSS_CHECK_INTERVAL_MINUTES: Check interval in minutes
 *   Default: 15 minutes
 */
export const rssPlugin: Plugin = {
  name: "rss",
  description: "RSS/Atom feed monitoring and subscription management",

  config: {
    RSS_FEEDS: process.env.RSS_FEEDS ?? null,
    RSS_DISABLE_ACTIONS: process.env.RSS_DISABLE_ACTIONS ?? null,
    RSS_FEED_FORMAT: process.env.RSS_FEED_FORMAT ?? null,
    RSS_CHECK_INTERVAL_MINUTES: process.env.RSS_CHECK_INTERVAL_MINUTES ?? null,
  },

  async init(_config: Record<string, string>, _runtime: IAgentRuntime): Promise<void> {
    logger.info("Initializing RSS plugin");
    // Plugin initialization is handled by the service start
  },

  evaluators: [],
  providers: [feedItemsProvider],
  actions,
  services: [RssService],

  tests: [
    {
      name: "rss_plugin_tests",
      tests: [
        {
          name: "rss_test_parser",
          fn: async (_runtime: IAgentRuntime): Promise<void> => {
            const { parseRssToJson } = await import("./parser");

            const sampleRss = `<?xml version="1.0"?>
              <rss version="2.0">
                <channel>
                  <title>Test Feed</title>
                  <link>https://example.com</link>
                  <description>A test RSS feed</description>
                  <item>
                    <title>Test Article</title>
                    <link>https://example.com/article1</link>
                    <description>This is a test article</description>
                    <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
                    <guid>article-1</guid>
                  </item>
                </channel>
              </rss>`;

            const feed = parseRssToJson(sampleRss);

            if (feed.title !== "Test Feed") {
              throw new Error(`Expected title "Test Feed", got "${feed.title}"`);
            }

            if (feed.items.length !== 1) {
              throw new Error(`Expected 1 item, got ${feed.items.length}`);
            }

            const firstItem = feed.items[0];
            if (firstItem && firstItem.title !== "Test Article") {
              throw new Error(`Expected item title "Test Article", got "${firstItem.title}"`);
            }

            logger.info("[RSS Test] Parser test passed");
          },
        },
        {
          name: "rss_test_url_extraction",
          fn: async (_runtime: IAgentRuntime): Promise<void> => {
            const { extractUrls } = await import("./utils");

            const text = "Check out https://example.com/feed.rss and http://test.com for more.";
            const urls = extractUrls(text);

            if (urls.length !== 2) {
              throw new Error(`Expected 2 URLs, got ${urls.length}`);
            }

            if (!urls.includes("https://example.com/feed.rss")) {
              throw new Error("Missing expected URL: https://example.com/feed.rss");
            }

            logger.info("[RSS Test] URL extraction test passed");
          },
        },
        {
          name: "rss_test_service_exists",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const service = runtime.getService("RSS");

            if (!service) {
              throw new Error("RSS service not found");
            }

            logger.info("[RSS Test] Service existence test passed");
          },
        },
      ],
    },
  ],
};

export default rssPlugin;
