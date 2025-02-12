// TODO: 
import {
    type Action,
    type ActionExample,
    type Content,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    composeContext,
    generateText,
    logger
} from "@elizaos/core";
import type { TwitterConfig } from '../environment';

const tweetGenerationTemplate = `# Task: Generate a tweet in the style and voice of {{agentName}}.

About {{agentName}}:
{{bio}}
{{lore}}
{{topics}}

{{characterPostExamples}}

Recent Context:
{{recentMessages}}

# Instructions: Write a tweet that captures the essence of what {{agentName}} wants to share. The tweet should be:
- Under {{maxTweetLength}} characters
- In {{agentName}}'s authentic voice and style
- Related to the ongoing conversation or context
- Not include hashtags unless specifically requested
- Natural and conversational in tone

Return only the tweet text, no additional commentary.`;

const twitterPostAction = {
    name: "TWITTER_POST",
    similes: [
        "POST_TWEET",
        "SHARE_TWEET",
        "TWEET_THIS",
        "TWEET_ABOUT",
        "TWEET_IDEA",
        "POST_ON_TWITTER",
        "SHARE_ON_TWITTER"
    ],
    description: "Creates and posts a tweet based on the conversation context",
    validate: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State
    ) => {
        // Only show for users with twitter configured
        if (!state.twitterClient) {
            return false;
        }

        const keywords = [
            "tweet this",
            "tweet that",
            "post this",
            "share this",
            "tweet about",
            "tweet it",
            "post on twitter",
            "share on twitter",
            "make a tweet",
            "write a tweet",
            "tweet idea",
            "twitter post",
            "post that on twitter",
            "share that on twitter"
        ];

        const messageText = message.content.text.toLowerCase();
        return keywords.some(keyword => messageText.includes(keyword));
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback,
        responses: Memory[]
    ) => {
        try {
            for (const response of responses) {
                await callback(response.content);
            }

            const twitterConfig = (state.twitterClient as any)?.twitterConfig as TwitterConfig;
            const maxTweetLength = twitterConfig?.MAX_TWEET_LENGTH || 280;

            // Generate the tweet content
            const context = composeContext({
                state: {
                    ...state,
                    maxTweetLength
                },
                template: tweetGenerationTemplate
            });

            const tweetContent = await generateText({
                runtime,
                context,
                modelClass: ModelClass.TEXT_SMALL
            });

            // Clean up the generated content
            const cleanTweet = tweetContent
                .trim()
                .replace(/^["'](.*)["']$/, '$1') // Remove surrounding quotes if present
                .replace(/\\n/g, '\n'); // Handle newlines properly

            // Prepare the response content
            const responseContent: Content = {
                text: `I'll tweet this:\n\n${cleanTweet}`,
                action: "TWITTER_POST",
                source: message.content.source,
            };

            // If we're in dry run mode, just show what would be tweeted
            if (twitterConfig?.TWITTER_DRY_RUN) {
                await callback(responseContent);
                return responseContent;
            }

            // Post the tweet using the TwitterPost client
            const memories = await (state.twitterClient as any).requestQueue.add(async () => {
                const result = await (state.twitterClient as any).sendTweet(cleanTweet);
                if (!result?.data?.create_tweet?.tweet_results?.result) {
                    throw new Error("Failed to post tweet");
                }
                return result;
            });

            // Send the response with the tweet URL
            await callback(responseContent);
            
            return responseContent;

        } catch (error) {
            logger.error("Error in TWITTER_POST action:", error);
            const errorContent: Content = {
                text: "Sorry, I wasn't able to post that tweet.",
                action: "TWITTER_POST",
                source: message.content.source
            };
            await callback(errorContent);
            return errorContent;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "That's such a great point about neural networks! You should tweet that",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Good idea! I'll share that thought on Twitter",
                    action: "TWITTER_POST",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Oh that gives me a great idea for a tweet!",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Let me tweet that out right now",
                    action: "TWITTER_POST",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "You should share your thoughts about this on Twitter",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll post a tweet about it",
                    action: "TWITTER_POST",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you tweet what you just said about quantum computing?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll compose a tweet about that now",
                    action: "TWITTER_POST",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Tweet this conversation, it's really insightful!",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll tweet a summary of our discussion",
                    action: "TWITTER_POST",
                },
            },
        ]
    ] as ActionExample[][]
} as Action;

export default twitterPostAction;