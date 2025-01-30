import dotenv from "dotenv";
dotenv.config();
import {
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
    ModelClass,
    HandlerCallback,
    ActionExample,
    type Action,
} from "@elizaos/core";
// @ts-ignore
import DKG from "dkg.js";
import { Scraper, Tweet } from "agent-twitter-client";
import vader from "vader-sentiment";

let DkgClient: any = null;

function calculateVaderScore(statement) {
    return vader.SentimentIntensityAnalyzer.polarity_scores(statement).compound;
}

function getMostInfluentialAuthors(tweets: Tweet[], maxNumberOfAuthors = 5) {
    const sortedAuthors = tweets
        .sort((a, b) => b.views - a.views)
        .map((tweet) => tweet.username);

    const distinctAuthors = [...new Set(sortedAuthors)].slice(
        0,
        maxNumberOfAuthors,
    );

    return distinctAuthors;
}

export const dkgInsert: Action = {
    name: "DKG_ANALYZE_SENTIMENT",
    similes: ["ANALYZE_SENTIMENT", "SENTIMENT"], // we want to always run this action
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        const requiredEnvVars = [
            "DKG_ENVIRONMENT",
            "DKG_HOSTNAME",
            "DKG_PORT",
            "DKG_BLOCKCHAIN_NAME",
            "DKG_PUBLIC_KEY",
            "DKG_PRIVATE_KEY",
        ];

        const missingVars = requiredEnvVars.filter(
            (varName) => !runtime.getSetting(varName),
        );

        if (missingVars.length > 0) {
            elizaLogger.error(
                `Missing required environment variables: ${missingVars.join(", ")}`,
            );
            return false;
        }

        return true;
    },
    description:
        "Analyze a stock, cryptocurrency, token or a financial asset's sentiment on X.",
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback: HandlerCallback,
    ): Promise<boolean> => {
        DkgClient = new DKG({
            environment: runtime.getSetting("DKG_ENVIRONMENT"),
            endpoint: runtime.getSetting("DKG_HOSTNAME"),
            port: runtime.getSetting("DKG_PORT"),
            blockchain: {
                name: runtime.getSetting("DKG_BLOCKCHAIN_NAME"),
                publicKey: runtime.getSetting("DKG_PUBLIC_KEY"),
                privateKey: runtime.getSetting("DKG_PRIVATE_KEY"),
            },
            maxNumberOfRetries: 300,
            frequency: 2,
            contentType: "all",
            nodeApiVersion: "/v1",
        });

        const currentPost = String(state.currentPost);
        elizaLogger.log(`currentPost: ${currentPost}`);

        const topic = "$NVDA"; // todo actually extract topic
        elizaLogger.log(`Extracted topic to analyze sentiment: ${topic}`);

        const twitterScraper = new Scraper();
        const scraper = twitterScraper.searchTweets(
            `"${topic}" is:verified`,
            100,
        );

        let tweets = [];

        for await (const tweet of scraper) {
            tweets.push(tweet);
        }
        elizaLogger.log(`Successfully fetched ${tweets.length} tweets.`);

        tweets = tweets.map((t) => ({
            ...t,
            vaderSentimentScore: calculateVaderScore(t.text),
        }));
        elizaLogger.log(`Calculated sentiment scores for tweets.`);

        const topAuthors = getMostInfluentialAuthors(tweets);
        elizaLogger.log("Got most influential authors");

        // Reply
        // callback({
        //     text: `Created a new memory!\n\nRead my mind on @origin_trail Decentralized Knowledge Graph ${DKG_EXPLORER_LINKS[runtime.getSetting("DKG_ENVIRONMENT")]}${createAssetResult.UAL} @${twitterUser}`,
        // });

        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "execute action DKG_INSERT",
                    action: "DKG_INSERT",
                },
            },
            {
                user: "{{user2}}",
                content: { text: "DKG INSERT" },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "add to dkg", action: "DKG_INSERT" },
            },
            {
                user: "{{user2}}",
                content: { text: "DKG INSERT" },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "store in dkg", action: "DKG_INSERT" },
            },
            {
                user: "{{user2}}",
                content: { text: "DKG INSERT" },
            },
        ],
    ] as ActionExample[][],
} as Action;
