import type {
    Action,
    ActionExample,
    HandlerCallback,
    HandlerOptions,
    IAgentRuntime,
    Memory,
    State,
} from '@elizaos/core';
import { createUniqueUuid } from '@elizaos/core';
import { RssService } from '../service';
import { createMessageReply, extractUrls } from '../utils';

export const getFeedAction: Action = {
    name: 'GET_NEWSFEED',
    similes: ['FETCH_RSS', 'READ_FEED', 'DOWNLOAD_FEED'],
    validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => {
        return true;
    },
    description: 'Download and parse an RSS/Atom feed from a URL',
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State,
        _options?: HandlerOptions,
        callback?: HandlerCallback,
        _responses?: Memory[]
    ) => {
        runtime.logger.log('GET_NEWSFEED Starting handler...');

        const service = runtime.getService('RSS') as RssService;
        if (!service) {
            runtime.logger.error('RSS service not found');
            callback?.(createMessageReply(runtime, message, 'RSS service is not available'));
            return;
        }

        const urls = extractUrls(message.content.text);
        const validUrls = urls.filter(u => u.match(/rss|feed|atom|xml/i) || u.endsWith('.rss') || u.endsWith('.xml'));

        if (!validUrls.length) {
            // Fall back to any URL if no RSS-specific URLs found
            if (urls.length > 0) {
                validUrls.push(urls[0]);
            } else {
                runtime.logger.warn('No valid URLs found in message');
                callback?.(createMessageReply(runtime, message, 'No valid RSS feed URL provided'));
                return;
            }
        }
        
        const url = validUrls[0];
        const res = await service.fetchUrl(url);
        
        if (!res) {
            runtime.logger.error({ url }, 'Failed to fetch RSS feed');
            callback?.(createMessageReply(runtime, message, 'Failed to fetch RSS feed'));
            return;
        }
        
        runtime.logger.info({ count: res.items.length, title: res.title || url }, 'Fetched items from RSS feed');
        
        let newItemCount = 0;
        
        for (const item of res.items) {
            // Primary ID: based on guid
            const primaryId = createUniqueUuid(runtime, `${url}_${item.guid}`);
            
            // Fallback ID: based on title and pubDate (for feeds with inconsistent guids)
            const fallbackId = createUniqueUuid(runtime, `${url}_${item.title}_${item.pubDate}`);

            // Check both IDs to avoid duplicates
            const existingByGuid = await runtime.getMemoriesByIds([primaryId], 'feeditems');
            const existingByTitleDate = await runtime.getMemoriesByIds([fallbackId], 'feeditems');

            // Only create if item doesn't exist by either method
            if ((!existingByGuid || existingByGuid.length === 0) && 
                (!existingByTitleDate || existingByTitleDate.length === 0)) {
                
                // Use primary ID if guid exists, otherwise use fallback
                const itemId = item.guid ? primaryId : fallbackId;

                const itemMemory: Memory = {
                    id: itemId,
                    entityId: runtime.agentId,
                    agentId: runtime.agentId,
                    content: {
                        text: item.title,
                        url: item.link
                    },
                    roomId: message.roomId,
                    createdAt: Date.now(),
                    metadata: {
                        ...item,
                        feedUrl: url,
                        feedTitle: res.title,
                        type: 'feed_item'
                    }
                };
                
                await runtime.createMemory(itemMemory, 'feeditems');
                newItemCount++;
            }
        }

        // Auto-subscribe to the feed after successful fetch
        await service.subscribeFeed(url, res.title);

        // Send response
        const responseText = newItemCount > 0 
            ? `Downloaded ${res.items.length} articles from "${res.title}", ${newItemCount} new items stored. Feed auto-subscribed for periodic updates.`
            : `Downloaded ${res.items.length} articles from "${res.title}", all items already stored. Feed auto-subscribed for periodic updates.`;
        
        callback?.(createMessageReply(runtime, message, responseText));
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
                    text: "I'll check that out",
                    actions: ['GET_NEWSFEED'],
                },
            },
        ],
        [
            {
                name: '{{name1}}',
                content: {
                    text: 'Fetch the news from https://news.ycombinator.com/rss',
                },
            },
            {
                name: '{{name2}}',
                content: {
                    text: 'Fetching the Hacker News feed now',
                    actions: ['GET_NEWSFEED'],
                },
            },
        ],
    ] as ActionExample[][],
};

export default getFeedAction;

