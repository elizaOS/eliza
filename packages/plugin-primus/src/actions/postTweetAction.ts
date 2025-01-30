import {
    type Action,
    elizaLogger,
    type IAgentRuntime,
    type Memory,
    type State,
} from "@elizaos/core";
import { TwitterScraper } from "../util/twitterScraper.ts";
import {tokenPriceProvider} from "../providers/tokenPriceProvider.ts";

export const postTweetAction: Action = {
    description: "Post a tweet on Twitter and be verified by Primus",
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Get the latest BTC price and post it on my twitter.",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "The latest tweet has posted.",
                    action: "POST_TWEET",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Help post a tweet which content is BTC price.",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Completed!",
                    action: "POST_TWEET",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Post a tweet on twitter for me.",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I'll post the latest tweet to your Twitter account now!",
                    action: "POST_TWEET",
                },
            },
        ],
    ],
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State
    ): Promise<boolean> => {
        const contentYouWantToPost = await tokenPriceProvider.get(runtime, message, state);
        //check VERIFIABLE_INFERENCE_ENABLED
        if (
            !(
                process.env.VERIFIABLE_INFERENCE_ENABLED === "true" &&
                process.env.PRIMUS_APP_ID &&
                process.env.PRIMUS_APP_SECRET
            )
        ) {
            elizaLogger.error(
                `Parameter 'VERIFIABLE_INFERENCE_ENABLED' not set, Eliza will run this action!`
            );
            return false;
        }

        try {
            if (
                process.env.TWITTER_DRY_RUN &&
                process.env.TWITTER_DRY_RUN.toLowerCase() === "true"
            ) {
                elizaLogger.info(
                    `Dry run: would have posted tweet: ${contentYouWantToPost}`
                );
                return true;
            }

            const scraperWithPrimus = new TwitterScraper();
            await scraperWithPrimus.login();
            if (!(await scraperWithPrimus.getScraper().isLoggedIn())) {
                elizaLogger.error("Failed to login to Twitter");
                return false;
            }
            // post the tweet
            elizaLogger.log("Attempting to send tweet:", contentYouWantToPost);
            const result = await scraperWithPrimus.sendTweet(contentYouWantToPost);

            elizaLogger.log("Tweet response:", result);

            // Check for Twitter API errors
            if (!result) {
                elizaLogger.error(`Twitter API error ${result}`);
                return false;
            }
            return true;
        } catch (error) {
            elizaLogger.error("Error in post action:", error);
            return false;
        }
    },
    name: "POST_TWEET",
    similes: ["TWEET", "POST", "SEND_TWEET"],
    validate: async (
        // eslint-disable-next-line
        _runtime: IAgentRuntime,
        // eslint-disable-next-line
        _message: Memory,
        // eslint-disable-next-line
        _state?: State
    ) => {
        const hasCredentials =
            !!process.env.TWITTER_USERNAME && !!process.env.TWITTER_PASSWORD;
        elizaLogger.log(`Has credentials: ${hasCredentials}`);

        return hasCredentials;
    },
};
