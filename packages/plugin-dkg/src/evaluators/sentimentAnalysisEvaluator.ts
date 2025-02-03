import {
    generateText,
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
    ModelClass,
    HandlerCallback,
    Evaluator,
} from "@elizaos/core";
import { isSentimentAnalysisQueryPrompt } from "../constants.ts";
import DKG from "dkg.js";
import { Scraper, Tweet } from "agent-twitter-client";
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

function calculateVaderScore(statement: string) {
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

export class SentimentAnalysisEvaluator implements Evaluator {
    name = "SENTIMENT_ANALYSIS_EVALUATOR";
    similes = ["sentiment", "evaluate sentiment", "check sentiment"];
    description = "Evaluates messages for sentiment analysis requests";
    alwaysRun = true;

    async validate(runtime: IAgentRuntime, message: Memory): Promise<boolean> {
        elizaLogger.log("Entering sentiment analysis evaluator!");

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

        const content =
            typeof message.content === "string"
                ? message.content
                : message.content?.text;

        if (!content) return false;

        const context = isSentimentAnalysisQueryPrompt(content);

        const isSentimentQuery = await generateText({
            runtime,
            context,
            modelClass: ModelClass.MEDIUM,
        });

        elizaLogger.log(
            `Evaluated user query for sentiment analysis, decision: ${isSentimentQuery}`,
        );

        return isSentimentQuery.toLowerCase() === "yes";
    }

    async handler(
        runtime: IAgentRuntime,
        _message: Memory,
        state: State,
        _options?: { [key: string]: unknown },
        callback?: HandlerCallback,
    ): Promise<Boolean> {
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

        // // todo currentPost is undefined
        // const currentPost = String(state.currentPost);
        // elizaLogger.log(`currentPost: ${currentPost}`);

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
            `"${topic}" is:verified`,
            100,
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
                .slice(5)
                .map((a) => `@${a}`)
                .join(", ")}

            This is not financial advice.`,
        });

        return true;
    }

    examples = [];
}

export const sentimentAnalysisEvaluator = new SentimentAnalysisEvaluator();
