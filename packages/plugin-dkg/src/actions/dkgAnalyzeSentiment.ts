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
    generateText,
} from "@elizaos/core";
// @ts-ignore
import DKG from "dkg.js";
import { Scraper, Tweet, SearchMode } from "agent-twitter-client";
import vader from "vader-sentiment";
import {
    getRelatedDatasetsQuery,
    getSentimentAnalysisQuery,
    DKG_EXPLORER_LINKS,
    extractSentimentAnalysisTopic,
} from "../constants";
import { fetchFileFromUrl, getSentimentChart } from "../http-helper";

let DkgClient: any = null;

export async function postTweet(
    content: string,
    scraper: Scraper,
    postId?: string,
    media?: Buffer,
): Promise<boolean> {
    try {
        elizaLogger.log("Attempting to send tweet:", content);

        const result = await scraper.sendNoteTweet(content, postId, [
            {
                data: media,
                mediaType: "image/png",
            },
        ]);

        const body = await result.json();
        elizaLogger.log("Tweet response:", body);

        if (body.errors) {
            const error = body.errors[0];
            elizaLogger.error(
                `Twitter API error (${error.code}): ${error.message}`,
            );
            return false;
        }

        if (!body?.data?.create_tweet?.tweet_results?.result) {
            elizaLogger.error(
                "Failed to post tweet: No tweet result in response",
            );
            return false;
        }

        return true;
    } catch (error) {
        elizaLogger.error("Error posting tweet:", {
            message: error.message,
            stack: error.stack,
            name: error.name,
            cause: error.cause,
        });
        return false;
    }
}

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

function extractUsernameFromUrl(url: string) {
    const match = url.match(/https:\/\/x\.com\/([^\/]+)\/status\/\d+/);
    return match ? match[1] : "unknown";
}

type StructureKAOptions = {
    dkgClient: any;
    environment: string;
};

async function structureKA(
    tweets: (Tweet & { vaderSentimentScore: number })[],
    topic: string,
    tweetCreator: string,
    options: StructureKAOptions,
) {
    const { dkgClient, environment } = options;

    const observations = tweets.map((t) => ({
        "@context": "http://schema.org",
        "@type": "Observation",
        "@id": `https://x.com/${t.username}/status/${t.id}`,
        observationDate: new Date(t.timestamp * 1000).toISOString(),
        value: t.vaderSentimentScore,
        variableMeasured: "VADER sentiment",
        impressions: t.views ?? 0,
        author: t.username,
    }));

    const todayISOString = new Date().toISOString();

    let previousAnalyses: any = [];

    try {
        const getPreviousAnalysesQuery = getSentimentAnalysisQuery(topic);
        previousAnalyses = await dkgClient.graph.query(
            getPreviousAnalysesQuery,
            "SELECT",
        );
    } catch (error) {
        console.error("Failed to fetch previous analyses:", error);
        previousAnalyses = [];
    }

    const allTweets: (Tweet & { vaderSentimentScore: number })[] =
        previousAnalyses.data?.length
            ? [
                  ...tweets.map((t) => ({
                      ...t,
                      id: `https://x.com/${t.username}/status/${t.id}`,
                  })),
                  ...previousAnalyses.data.map((a) => ({
                      id: a.observation,
                      views: a.impressions ?? 0,
                      vaderSentimentScore: a.score ?? 0,
                      author: extractUsernameFromUrl(a.observation),
                  })),
              ]
            : tweets.map((t) => ({
                  ...t,
                  id: `https://x.com/${t.username}/status/${t.id}`,
              }));

    const uniqueTweets = Array.from(
        new Map(allTweets.map((tweet) => [tweet.id, tweet])).values(),
    );

    const weightedAverageSentimentScore = uniqueTweets.reduce(
        (acc, tweet) => {
            const weight = tweet.views ?? 0;
            const sentiment = tweet.vaderSentimentScore ?? 0;

            return {
                totalWeightedScore: acc.totalWeightedScore + sentiment * weight,
                totalImpressions: acc.totalImpressions + weight,
            };
        },
        { totalWeightedScore: 0, totalImpressions: 0 },
    );

    const averageScore =
        weightedAverageSentimentScore.totalImpressions > 0
            ? weightedAverageSentimentScore.totalWeightedScore /
              weightedAverageSentimentScore.totalImpressions
            : 0;

    let relatedDatasets: any = [];

    try {
        const relatedDatasetsQuery = getRelatedDatasetsQuery(topic);
        relatedDatasets = await dkgClient.graph.query(
            relatedDatasetsQuery,
            "SELECT",
        );
    } catch (error) {
        console.error("Failed to fetch related datasets:", error);
        relatedDatasets = [];
    }

    const ka = {
        "@context": "http://schema.org",
        "@id": `https://x.com/search?q=${encodeURIComponent(topic)}&src=typed_query&f=top&date=${todayISOString}`,
        "@type": "Dataset",
        name: `Sentiment analysis on recent ${topic} X posts - ${todayISOString}`,
        url: `https://x.com/search?q=${encodeURIComponent(topic)}&src=typed_query&f=top`,
        author: tweetCreator,
        dateCreated: todayISOString,
        averageScore: averageScore,
        variableMeasured: "VADER sentiment",
        observation: observations,
        about: topic,
        relatedAnalysis: (relatedDatasets.data ?? []).map((rd) => ({
            isPartOf: rd.ual,
            "@id": rd.dataset,
        })),
    };

    return { ka, averageScore, numOfTotalTweets: allTweets.length };
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

        const idRegex = /ID:\s(\d+)/;
        let match = currentPost.match(idRegex);
        let postId = "";
        if (match && match[1]) {
            postId = match[1];
            elizaLogger.log(`Extracted ID: ${postId}`);
        } else {
            elizaLogger.log("No ID found.");
        }

        const userRegex = /From:.*\(@(\w+)\)/;
        match = currentPost.match(userRegex);
        let twitterUser = "";

        if (match && match[1]) {
            twitterUser = match[1];
            elizaLogger.log(`Extracted user: @${twitterUser}`);
        } else {
            elizaLogger.log("No user mention found or invalid input.");
        }

        const topic = await generateText({
            runtime,
            context: extractSentimentAnalysisTopic(currentPost),
            modelClass: ModelClass.SMALL,
        });

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
            let attempts = 0;
            const maxAttempts = 5;

            while (attempts < maxAttempts) {
                attempts++;
                elizaLogger.warn(`Login attempt ${attempts} with cookies...`);

                await scraper.setCookies(
                    formatCookiesFromArray(
                        JSON.parse(process.env.TWITTER_COOKIES),
                    ),
                );

                if (await scraper.isLoggedIn()) {
                    elizaLogger.info("Successfully logged in with cookies.");
                    break;
                }

                if (attempts === maxAttempts) {
                    elizaLogger.error(
                        "Failed to login to Twitter after multiple attempts.",
                    );
                    return false;
                }
            }
        }

        const scrapedTweets = scraper.searchTweets(
            topic,
            100,
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

        const { ka, averageScore, numOfTotalTweets } = await structureKA(
            tweets,
            topic,
            twitterUser,
            {
                dkgClient: DkgClient,
                environment: runtime.getSetting("DKG_ENVIRONMENT"),
            },
        );

        const sentiment =
            averageScore <= 0.1
                ? "Neutral ⚪️"
                : averageScore > 0
                  ? "Positive 🟢"
                  : "Negative 🔴";

        const createAssetResult = await DkgClient.asset.create(
            {
                public: ka,
            },
            { epochsNum: 12 },
        );

        const sentimentData = await getSentimentChart(averageScore, topic);

        const file = await fetchFileFromUrl(sentimentData.url);

        await postTweet(
            `${topic} sentiment based on top ${tweets.length} latest posts${
                numOfTotalTweets - tweets.length > 0
                    ? ` and ${numOfTotalTweets - tweets.length} existing analysis Knowledge Assets`
                    : ""
            } from the past 48 hours: ${sentiment}

        Top 5 most influential accounts analyzed for ${topic}:
        ${topAuthors
            .slice(0, 5)
            .map((a) => `@${a}`)
            .join(", ")}

        Analysis memorized on @origin_trail Decentralized Knowledge Graph ${
            DKG_EXPLORER_LINKS[runtime.getSetting("DKG_ENVIRONMENT")]
        }${createAssetResult.UAL} @${twitterUser}

        This is not financial advice.`,
            scraper,
            postId,
            file.data,
        );

        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "How is Tesla doing right now?",
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
