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
import { rssService } from '../service'

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
function extractUrls(text): string[] {
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

  function isValidUrl(u) {
    try { new URL(u); return true; } catch { return false; }
  }
}

export default {
    name: 'GET_NEWSFEED',
    similes: [
    ],
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        return true;
    },
    description: 'Download RSS/atom feed',
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        _options?: HandlerOptions,
        callback?: HandlerCallback,
        responses?: Memory[]
    ) => {
        runtime.logger.log('GET_NEWSFEED Starting handler...');

        const service = runtime.getService('RSS') as rssService;
        const urls = extractUrls(message.content.text)
        const validUrls = urls.filter(u => u.match(/rss/i))

        if (!validUrls.length) {
          runtime.logger.error('No valid URLs found in message');
          callback?.(messageReply(runtime, message, 'No valid RSS feed URL provided'))
          return
        }
        
        const url = validUrls[0]
        const res = await service.fetchUrl(url)
        
        if (!res) {
          runtime.logger.error(`Failed to fetch RSS feed: ${url}`);
          callback?.(messageReply(runtime, message, 'Failed to fetch RSS feed'))
          return
        }
        
        runtime.logger.info(`Fetched ${res.items.length} items from RSS feed: ${res.title || url}`);
        
        let newItemCount = 0;
        
        for(const i of res.items) {
          // Primary ID: based on guid
          const primaryId = createUniqueUuid(runtime, `${url}_${i.guid}`)
          
          // Fallback ID: based on title and pubDate (for feeds with inconsistent guids)
          const fallbackId = createUniqueUuid(runtime, `${url}_${i.title}_${i.pubDate}`)

          // Check both IDs to avoid duplicates
          const existingByGuid = await runtime.getMemoriesByIds([primaryId], 'feeditems')
          const existingByTitleDate = await runtime.getMemoriesByIds([fallbackId], 'feeditems')

          // Only create if item doesn't exist by either method
          if ((!existingByGuid || existingByGuid.length === 0) && 
              (!existingByTitleDate || existingByTitleDate.length === 0)) {
            
            // Use primary ID if guid exists, otherwise use fallback
            const itemId = i.guid ? primaryId : fallbackId;

            const itemMemory: Memory = {
              id: itemId,
              entityId: runtime.agentId,
              agentId: runtime.agentId,
              content: {
                text: i.title,
                url: i.link
              },
              roomId: message.roomId,
              createdAt: Date.now(),
              metadata: {
                ...i,
                feedUrl: url,
                feedTitle: res.title,
                type: 'feed_item'
              }
            };
            
            await runtime.createMemory(itemMemory, 'feeditems')
            newItemCount++;
          }
        }

        // Auto-subscribe to the feed after successful fetch
        await service.subscribeFeed(url, res.title);

        // Send response
        const responseText = newItemCount > 0 
          ? `Downloaded ${res.items.length} articles from "${res.title}", ${newItemCount} new items stored. Feed auto-subscribed for periodic updates.`
          : `Downloaded ${res.items.length} articles from "${res.title}", all items already stored. Feed auto-subscribed for periodic updates.`;
        
        callback?.(messageReply(runtime, message, responseText))
    },

    examples: [
        [
            {
                name: '{{name1}}',
                content: {
                    text: 'Read https://server.com/feed.rss',
                },
            },
            {
                name: '{{name2}}',
                content: {
                    text: 'I\'ll check that out',
                    actions: ['GET_NEWSFEED'],
                },
            },
        ],
    ] as ActionExample[][],
} as Action;

