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

export default {
    name: 'LIST_RSS_FEEDS',
    similes: ['SHOW_RSS_FEEDS', 'GET_RSS_FEEDS', 'RSS_SUBSCRIPTIONS'],
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        return true;
    },
    description: 'List all subscribed RSS/Atom feeds',
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        _options?: HandlerOptions,
        callback?: HandlerCallback,
        responses?: Memory[]
    ) => {
        runtime.logger.log('LIST_RSS_FEEDS Starting handler...');

        const service = runtime.getService('RSS') as rssService;
        if (!service) {
            runtime.logger.error('RSS service not found');
            callback?.(messageReply(runtime, message, 'RSS service is not available'));
            return;
        }

        const feeds = await service.getSubscribedFeeds();

        if (!feeds || feeds.length === 0) {
            callback?.(messageReply(
                runtime, 
                message, 
                'No RSS feeds are currently subscribed. Use the subscribe action to add feeds.'
            ));
            return;
        }

        // Format the feed list
        let feedList = `You are subscribed to ${feeds.length} RSS feed${feeds.length > 1 ? 's' : ''}:\n\n`;
        
        feeds.forEach((feed, index) => {
            const title = feed.content.text || 'Untitled Feed';
            const url = feed.content.url || 'Unknown URL';
            const metadata = feed.metadata as any;
            const lastChecked = metadata?.lastChecked;
            const itemCount = metadata?.lastItemCount || 0;
            
            feedList += `${index + 1}. ${title}\n`;
            feedList += `   URL: ${url}\n`;
            
            if (lastChecked && lastChecked > 0) {
                const lastCheckDate = new Date(lastChecked);
                const timeSince = Date.now() - lastChecked;
                const minutesSince = Math.floor(timeSince / 60000);
                const hoursSince = Math.floor(minutesSince / 60);
                const daysSince = Math.floor(hoursSince / 24);
                
                let timeStr = '';
                if (daysSince > 0) {
                    timeStr = `${daysSince} day${daysSince > 1 ? 's' : ''} ago`;
                } else if (hoursSince > 0) {
                    timeStr = `${hoursSince} hour${hoursSince > 1 ? 's' : ''} ago`;
                } else if (minutesSince > 0) {
                    timeStr = `${minutesSince} minute${minutesSince > 1 ? 's' : ''} ago`;
                } else {
                    timeStr = 'just now';
                }
                
                feedList += `   Last checked: ${timeStr} (${itemCount} items)\n`;
            } else {
                feedList += `   Last checked: Never\n`;
            }
            
            feedList += '\n';
        });

        callback?.(messageReply(runtime, message, feedList.trim()));
    },

    examples: [
        [
            {
                name: '{{name1}}',
                content: {
                    text: 'What RSS feeds am I subscribed to?',
                },
            },
            {
                name: '{{name2}}',
                content: {
                    text: 'Let me check your RSS subscriptions',
                    actions: ['LIST_RSS_FEEDS'],
                },
            },
        ],
        [
            {
                name: '{{name1}}',
                content: {
                    text: 'Show me my feeds',
                },
            },
            {
                name: '{{name2}}',
                content: {
                    text: 'Here are your RSS feeds',
                    actions: ['LIST_RSS_FEEDS'],
                },
            },
        ],
    ] as ActionExample[][],
} as Action;

