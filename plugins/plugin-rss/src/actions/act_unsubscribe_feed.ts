import {
    type Action,
    type ActionExample,
    type ChannelType,
    type Content,
    type HandlerCallback,
    type HandlerOptions,
    type IAgentRuntime,
    type Memory,
    type State,
    createUniqueUuid,
} from '@elizaos/core';
import { rssService } from '../service';

function messageReply(runtime: IAgentRuntime, message: Memory, reply: string): Content {
  return {
    text: reply,
    attachments: [],
    source: (message as any).source || 'unknown',
    channelType: (message as any).channelType as ChannelType | undefined,
    inReplyTo: createUniqueUuid(runtime, message.id || '')
  };
}

/**
 * Extract all URLs from a block of text.
 * - Supports http(s)://, ftp://, and schemeless "www." links
 * - Strips trailing punctuation like .,?!:;)]}'"… if it slipped into the match
 * - Normalizes and deduplicates results (returns absolute URLs with scheme)
 *
 * @param {string} text
 * @returns {string[]} Array of normalized URL strings
 */
function extractUrls(text: string): string[] {
  const URL_MATCH = /(?:(?:https?|ftp):\/\/|www\.)[^\s<>"'`]+/gi;
  const candidates = text.match(URL_MATCH) || [];

  const results: string[] = [];
  const seen = new Set();

  for (let raw of candidates) {
    // Trim leading wrappers like ( [ { < ' "
    let candidate = raw.replace(/^[(\[{<'"]+/, "");

    // Add scheme if missing
    let withScheme = candidate.startsWith("www.") ? `http://${candidate}` : candidate;

    // Iteratively trim common trailing punctuation until it parses (or give up)
    const TRAIL = /[)\]\}>,.;!?:'"\u2026]$/; // includes … (ellipsis)
    while (withScheme && TRAIL.test(withScheme.slice(-1)) && !isValidUrl(withScheme)) {
      withScheme = withScheme.slice(0, -1);
    }

    if (!isValidUrl(withScheme)) continue;

    const normalized = new URL(withScheme).toString();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      results.push(normalized);
    }
  }

  return results;

  function isValidUrl(u: string) {
    try { new URL(u); return true; } catch { return false; }
  }
}

export default {
    name: 'UNSUBSCRIBE_RSS_FEED',
    similes: ['REMOVE_RSS_FEED', 'UNFOLLOW_RSS_FEED', 'DELETE_RSS_FEED'],
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        return true;
    },
    description: 'Unsubscribe from an RSS/Atom feed',
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        _options?: HandlerOptions,
        callback?: HandlerCallback,
        responses?: Memory[]
    ) => {
        runtime.logger.log('UNSUBSCRIBE_RSS_FEED Starting handler...');

        const service = runtime.getService('RSS') as rssService;
        if (!service) {
            runtime.logger.error('RSS service not found');
            callback?.(messageReply(runtime, message, 'RSS service is not available'));
            return;
        }

        const urls = extractUrls(message.content.text);
        
        if (!urls.length) {
            runtime.logger.warn('No valid URLs found in message');
            callback?.(messageReply(runtime, message, 'Please provide a valid RSS feed URL to unsubscribe from'));
            return;
        }

        const url = urls[0];
        runtime.logger.debug(`Attempting to unsubscribe from feed: ${url}`);

        // Unsubscribe from the feed
        const success = await service.unsubscribeFeed(url);

        if (success) {
            callback?.(messageReply(
                runtime, 
                message, 
                `Successfully unsubscribed from ${url}`
            ));
        } else {
            callback?.(messageReply(
                runtime, 
                message, 
                `Unable to unsubscribe from ${url}. You may not be subscribed to this feed.`
            ));
        }
    },

    examples: [
        [
            {
                name: '{{name1}}',
                content: {
                    text: 'Unsubscribe from https://example.com/feed.rss',
                },
            },
            {
                name: '{{name2}}',
                content: {
                    text: 'I\'ll unsubscribe from that RSS feed for you',
                    actions: ['UNSUBSCRIBE_RSS_FEED'],
                },
            },
        ],
        [
            {
                name: '{{name1}}',
                content: {
                    text: 'Remove this feed: https://news.ycombinator.com/rss',
                },
            },
            {
                name: '{{name2}}',
                content: {
                    text: 'Removing the RSS feed',
                    actions: ['UNSUBSCRIBE_RSS_FEED'],
                },
            },
        ],
    ] as ActionExample[][],
} as Action;

