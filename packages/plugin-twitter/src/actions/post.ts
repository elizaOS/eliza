import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    composeContext,
    elizaLogger,
    generateText,
    ModelClass,
    formatMessages,
} from "@elizaos/core";
import { Scraper } from "agent-twitter-client";

async function composeTweet(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
): Promise<string> {
    try {
        // Get recent conversation history
        const recentMessages = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            count: 5,
        });

        const formattedHistory = formatMessages({
            messages: recentMessages,
            actors: state?.actorsData,
        });

        // Template for generating the tweet
        const tweetTemplate = `
# Context
Recent conversation:
${formattedHistory}

Character style:
${runtime.character.style.post.join("\n")}

Topics of expertise:
${runtime.character.topics.join(", ")}

# Task
Generate a tweet that:
1. Relates to the recent conversation or requested topic
2. Matches the character's style and voice
3. Is concise and engaging
4. Must be UNDER 180 characters (this is a strict requirement)
5. Speaks from the perspective of ${runtime.character.name}

Generate only the tweet text, no other commentary.`;

        const context = await composeContext({
            state,
            template: tweetTemplate,
        });

        const tweetContent = await generateText({
            runtime,
            context,
            modelClass: ModelClass.SMALL,
            stop: ["\n"],
        });

        const trimmedContent = tweetContent.trim();

        // Enforce character limit
        if (trimmedContent.length > 180) {
            elizaLogger.warn(
                `Tweet too long (${trimmedContent.length} chars), truncating...`
            );
            return trimmedContent.substring(0, 177) + "...";
        }

        return trimmedContent;
    } catch (error) {
        elizaLogger.error("Error composing tweet:", error);
        throw error;
    }
}

async function postTweet(content: string): Promise<boolean> {
    try {
        const scraper = new Scraper();
        const username = process.env.TWITTER_USERNAME;
        const password = process.env.TWITTER_PASSWORD;
        const email = process.env.TWITTER_EMAIL;
        const twitter2faSecret = process.env.TWITTER_2FA_SECRET;

        if (!username || !password) {
            throw new Error(
                "Twitter credentials not configured in environment"
            );
        }

        // Login with credentials
        await scraper.login(username, password, email, twitter2faSecret);
        if (!(await scraper.isLoggedIn())) {
            throw new Error("Failed to login to Twitter");
        }

        // Send the tweet
        elizaLogger.log("Attempting to send tweet:", content);
        const result = await scraper.sendTweet(content);

        const body = await result.json();
        elizaLogger.log("Tweet response:", body);

        // Check for Twitter API errors
        if (body.errors) {
            const error = body.errors[0];
            throw new Error(
                `Twitter API error (${error.code}): ${error.message}`
            );
        }

        // Check for successful tweet creation
        if (!body?.data?.create_tweet?.tweet_results?.result) {
            throw new Error(
                "Failed to post tweet: No tweet result in response"
            );
        }

        return true;
    } catch (error) {
        // Log the full error details
        elizaLogger.error("Error posting tweet:", {
            message: error.message,
            stack: error.stack,
            name: error.name,
            cause: error.cause,
        });
        return false;
    }
}

export const postAction: Action = {
    name: "POST_TWEET",
    similes: ["TWEET", "POST", "SEND_TWEET"],
    description: "Post a tweet to Twitter",
    validate: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State
    ) => {
        const hasCredentials =
            !!process.env.TWITTER_USERNAME && !!process.env.TWITTER_PASSWORD;
        elizaLogger.log(`Has credentials: ${hasCredentials}`);

        return hasCredentials;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State
    ): Promise<boolean> => {
        try {
            // Generate tweet content using context
            const tweetContent = await composeTweet(runtime, message, state);

            if (!tweetContent) {
                elizaLogger.error("No content generated for tweet");
                return false;
            }

            elizaLogger.log(`Generated tweet content: ${tweetContent}`);

            // Check for dry run mode - explicitly check for string "true"
            if (
                process.env.TWITTER_DRY_RUN &&
                process.env.TWITTER_DRY_RUN.toLowerCase() === "true"
            ) {
                elizaLogger.info(
                    `Dry run: would have posted tweet: ${tweetContent}`
                );
                return true;
            }

            return await postTweet(tweetContent);
        } catch (error) {
            elizaLogger.error("Error in post action:", error);
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Share your thoughts on AI" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "The future of AI lies in responsible development and ethical considerations. We must ensure it benefits all of humanity.",
                    action: "POST_TWEET",
                },
            },
        ],
    ],
};
