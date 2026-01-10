import type { IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import { logger } from '@elizaos/core';
import type { FeedItemMetadata } from '../types';

/**
 * Provider for RSS feed items
 * Provides recent feed items from subscribed RSS feeds to the agent's context
 */
export const feeditemsProvider: Provider = {
  name: 'FEEDITEMS',
  description: 'Provides recent news and articles from subscribed RSS feeds',
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    try {
      logger.debug('FEEDITEMS provider: Fetching feed items from memory');

      const items = await runtime.getMemories({
        tableName: 'feeditems',
        unique: false,
      });

      if (!items || items.length === 0) {
        logger.debug('No feed items found in memory');
        return {
          data: { items: [], count: 0 },
          values: {},
          text: 'No RSS feed items available. Subscribe to feeds to see news articles here.',
        };
      }

      // Sort by creation date (most recent first)
      const sortedItems = [...items].sort((a, b) => {
        const timeA = a.createdAt || 0;
        const timeB = b.createdAt || 0;
        return timeB - timeA;
      });

      // Limit to most recent 50 items to avoid overwhelming the context
      const recentItems = sortedItems.slice(0, 50);

      // Group items by feed for better organization
      const itemsByFeed = new Map<string, Memory[]>();
      for (const item of recentItems) {
        const metadata = item.metadata as FeedItemMetadata;
        const feedTitle = metadata?.feedTitle || 'Unknown Feed';
        if (!itemsByFeed.has(feedTitle)) {
          itemsByFeed.set(feedTitle, []);
        }
        itemsByFeed.get(feedTitle)!.push(item);
      }

      // Get format preference from settings (default: 'csv' for economy)
      // Options: 'csv' (compact, token-efficient) or 'markdown' (human-readable)
      const format = runtime.getSetting('RSS_FEED_FORMAT') || 'csv';

      let outputText: string;

      if (format === 'markdown') {
        // Markdown format - more readable but uses more tokens
        outputText = `# Recent RSS Feed Items (${recentItems.length} items from ${itemsByFeed.size} feeds)\n\n`;

        for (const [feedTitle, feedItems] of itemsByFeed) {
          outputText += `## ${feedTitle} (${feedItems.length} items)\n\n`;

          for (const item of feedItems) {
            const metadata = item.metadata as FeedItemMetadata;
            const title = item.content.text || metadata?.title || 'Untitled';
            const url = item.content.url || metadata?.link || '';
            const description = metadata?.description || '';
            const pubDate = metadata?.pubDate || '';
            const author = metadata?.author || '';

            outputText += `### ${title}\n`;
            if (url) {
              outputText += `- URL: ${url}\n`;
            }
            if (pubDate) {
              outputText += `- Published: ${pubDate}\n`;
            }
            if (author) {
              outputText += `- Author: ${author}\n`;
            }
            if (description) {
              // Truncate long descriptions
              const shortDesc = description.length > 200
                ? description.substring(0, 200) + '...'
                : description;
              outputText += `- Description: ${shortDesc}\n`;
            }
            outputText += '\n';
          }
        }
      } else {
        // CSV format (default) - compact and token-efficient
        outputText = `# RSS Feed Items (${recentItems.length} from ${itemsByFeed.size} feeds)\n`;
        outputText += 'Feed,Title,URL,Published,Description\n';

        for (const item of recentItems) {
          const metadata = item.metadata as FeedItemMetadata;
          const feedTitle = (metadata?.feedTitle || 'Unknown').replace(/"/g, '""');
          const title = (item.content.text || '').replace(/"/g, '""');
          const url = item.content.url || '';
          const pubDate = metadata?.pubDate || '';
          const description = (metadata?.description || '').replace(/"/g, '""').substring(0, 200);

          outputText += `"${feedTitle}","${title}","${url}","${pubDate}","${description}"\n`;
        }
      }

      const data = {
        items: recentItems,
        count: recentItems.length,
        totalCount: items.length,
        feedCount: itemsByFeed.size,
      };

      const values = {
        itemCount: recentItems.length,
        feedCount: itemsByFeed.size,
      };

      logger.debug(`FEEDITEMS provider: Returning ${recentItems.length} items from ${itemsByFeed.size} feeds (format: ${format})`);

      return {
        data,
        values,
        text: outputText,
      };
    } catch (error) {
      logger.error({ error }, 'Error in FEEDITEMS provider');
      return {
        data: { items: [], count: 0, error: String(error) },
        values: {},
        text: 'Error loading RSS feed items.',
      };
    }
  },
};

