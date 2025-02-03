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
import { Scraper, Tweet, SearchMode } from "agent-twitter-client";
import vader from "vader-sentiment";

let DkgClient: any = null;

function formatCookiesFromArray(cookiesArray: any[]) {
    const cookieStrings = cookiesArray.map(
        (cookie) =>
            `${cookie.key}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}; ${
                cookie.secure ? "Secure" : ""
            }; ${cookie.httpOnly ? "HttpOnly" : ""}; SameSite=${
                cookie.sameSite || "Lax"
            }`,
    );
    return cookieStrings;
}

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

export const dkgAnalyzeSentiment: Action = {
    name: "DKG_ANALYZE_SENTIMENT",
    similes: ["ANALYZE_SENTIMENT", "SENTIMENT"],
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
        "Analyze a stock, cryptocurrency, token or a financial asset's sentiment on X. You should run this action whenever the message asks about your thoughts/analysis/sentiment on a stock, cryptocurrency, token or a financial asset.",
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

        const scraper = new Scraper();

        const username = process.env.TWITTER_USERNAME;
        const password = process.env.TWITTER_PASSWORD;
        const email = process.env.TWITTER_EMAIL;
        const twitter2faSecret = process.env.TWITTER_2FA_SECRET;
        if (!username || !password) {
            elizaLogger.error(
                "Twitter credentials not configured in environment",
            );
            return false;
        }
        await scraper.login(username, password, email, twitter2faSecret);
        if (!(await scraper.isLoggedIn())) {
            // Login with cookies
            await scraper.setCookies(
                formatCookiesFromArray(JSON.parse(process.env.TWITTER_COOKIES)),
            );
            if (!(await scraper.isLoggedIn())) {
                elizaLogger.error("Failed to login to Twitter");
                return false;
            }
        }

        const scrapedTweets = scraper.searchTweets(
            topic,
            200,
            SearchMode.Latest,
        );

        let tweets = [];

        for await (const tweet of scrapedTweets) {
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

        const totalSentiment = tweets.reduce(
            (sum, t) => sum + t.vaderSentimentScore,
            0,
        );
        const averageSentiment = tweets.length
            ? totalSentiment / tweets.length
            : 0;

        const sentiment =
            averageSentiment <= 0.1
                ? "Neutral ⚪️"
                : averageSentiment > 0
                  ? "Positive 🟢"
                  : "Negative 🔴";

        // Reply
        callback({
            text: `${topic} sentiment based on top ${tweets.length} posts: ${sentiment}

            Top 5 most influential accounts analyzed for ${topic}:
            ${topAuthors
                .slice(0, 5)
                .map((a) => `@${a}`)
                .join(", ")}

            This is not financial advice.`,
        });

        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "execute action DKG_ANALYZE_SENTIMENT",
                    action: "DKG_ANALYZE_SENTIMENT",
                },
            },
            {
                user: "{{user2}}",
                content: { text: "DKG_ANALYZE_SENTIMENT" },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you analyze $TICKER",
                    action: "DKG_ANALYZE_SENTIMENT",
                },
            },
            {
                user: "{{user2}}",
                content: { text: "DKG_ANALYZE_SENTIMENT" },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What's the sentiment for #TICKER",
                    action: "DKG_ANALYZE_SENTIMENT",
                },
            },
            {
                user: "{{user2}}",
                content: { text: "DKG_ANALYZE_SENTIMENT" },
            },
        ],
    ] as ActionExample[][],
} as Action;
