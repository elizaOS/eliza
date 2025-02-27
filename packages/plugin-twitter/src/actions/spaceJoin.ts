import {
    type Action,
    type ActionExample,
    type IAgentRuntime,
    type Memory,
    type State,
    stringToUuid,
    HandlerCallback,
    logger
} from "@elizaos/core";
import { Tweet } from "../client";
import { SpaceActivity } from "../spaces";

export default {
    name: "JOIN_TWITTER_SPACE",
    similes: [
        "JOIN_TWITTER_SPACE",
        "JOIN_SPACE",
        "JOIN_TWITTER_AUDIO",
        "JOIN_TWITTER_CALL",
        "JOIN_LIVE_CONVERSATION",
    ],
    validate: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State
    ) => {
        if (message?.content?.source !== "twitter") {
            return false;
        }

        if (!message?.content?.tweet) {
            return false;
        }

        const spaceEnable = runtime.getSetting("TWITTER_SPACES_ENABLE") === true;
        return spaceEnable;
    },
    description: "Join a Twitter Space to participate in live audio conversations.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: any,
        callback: HandlerCallback,
        responses: Memory[]
    ): Promise<boolean> => {
        if (!state) {
            logger.error("State is not available.");
            return false;
        }

        for (const response of responses) {
            await callback(response.content);
        }
        
        const manager = runtime.getClient("twitter");
        if (!manager) {
            throw new Error("Twitter client manager not found");
        }

        const clientId = stringToUuid("default");
        const clientKey = manager.getClientKey(clientId, runtime.agentId)

        const client = manager.clients.get(clientKey).client;
        const spaceManager = manager.clients.get(clientKey).space;

        if (!spaceManager) {
            logger.error("space action - no space manager found")
            return false;
        }

        if (spaceManager.spaceStatus !== SpaceActivity.IDLE) {
            logger.warn("currently hosting/participating a space");
            return false;
        }

        const tweet = message.content.tweet as Tweet;
        if (!tweet) {
            logger.warn("space action - no tweet found in message")
            return false;
        }

        async function joinSpaceByUrls(tweet: Tweet): Promise<boolean> {
            if (!tweet.urls) return false;

            for (const url of tweet.urls) {
                const match = url.match(/https:\/\/x\.com\/i\/spaces\/([a-zA-Z0-9]+)/);
                if (match) {
                    const spaceId = match[1];
                    try {
                        const spaceInfo = await client.twitterClient.getAudioSpaceById(spaceId);
                        if (spaceInfo?.metadata?.state === "Running") {
                            const spaceJoined = await spaceManager.startParticipant(spaceId);
                            return !!spaceJoined;
                        }
                    } catch (error) {
                        logger.error("Error joining Twitter Space:", error);
                    }
                }
            }
            return false;
        }

        async function joinSpaceByUserName(userName: string): Promise<boolean> {
            try {
                const tweetGenerator = client.twitterClient.getTweets(userName);
                for await (const userTweet of tweetGenerator) {
                    if (await joinSpaceByUrls(userTweet)) {
                        return true;
                    }
                }
            } catch (error) {
                logger.error(`Error fetching tweets for ${userName}:`, error);
            }
            return false;
        }

        // Attempt to join a Twitter Space from URLs in the tweet
        const spaceJoined = await joinSpaceByUrls(tweet);
        if (spaceJoined) return true;

        // If no Space was found in the URLs, check if the tweet author has an active Space
        const authorJoined = await joinSpaceByUserName(tweet.username);
        if (authorJoined) return true;


        // If the tweet author isn't hosting a Space, check if any mentioned users are currently hosting one
        const agentName = client.state["TWITTER_USERNAME"];
        for (const mention of tweet.mentions) {
            if (mention.username !== agentName) {
                const mentionJoined = await joinSpaceByUserName(mention.username);
                if (mentionJoined) return true;
            }
        }
        await callback({
            text: "I couldn't determine which Twitter Space to join.",
            source: "twitter",
        });

        return false;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Hey, let's join the 'Crypto Talk' Twitter Space!",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "On my way",
                    action: "JOIN_TWITTER_SPACE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "@{{user2}}, jump into the 'AI Revolution' Space!",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Joining now!",
                    action: "JOIN_TWITTER_SPACE",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;