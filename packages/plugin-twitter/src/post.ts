import {
    cleanJsonResponse,
    composeContext,
    extractAttributes,
    generateText,
    type IAgentRuntime,
    logger,
    ModelClass,
    parseJSONObjectFromText,
    stringToUuid,
    truncateToCompleteSentence,
    type UUID
} from "@elizaos/core";
import type { ClientBase } from "./base.ts";
import type { Tweet } from "./client/index.ts";
import type { MediaData } from "./types.ts";
import { fetchMediaData } from "./utils.ts";

const twitterPostTemplate = `# Task: Create a post in the voice and style and perspective of {{agentName}} @{{twitterUserName}}.
{{system}}

# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
Your response should be 1, 2, or 3 sentences (choose the length at random).
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than 280. No emojis. Use \\n\\n (double spaces) between statements if there are multiple statements in your response.`;

export class TwitterPostClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    twitterUsername: string;
    private isProcessing = false;
    private lastProcessTime = 0;
    private stopProcessingActions = false;
    private isDryRun: boolean;
    private state: any;

    constructor(client: ClientBase, runtime: IAgentRuntime, state: any) {
        this.client = client;
        this.state = state;
        this.runtime = runtime;
        this.twitterUsername = state?.TWITTER_USERNAME || this.runtime.getSetting("TWITTER_USERNAME") as string;
        this.isDryRun = this.state?.TWITTER_DRY_RUN || this.runtime.getSetting("TWITTER_DRY_RUN") as unknown as boolean;

        // Log configuration on initialization
        logger.log("Twitter Client Configuration:");
        logger.log(`- Username: ${this.twitterUsername}`);
        logger.log(
            `- Dry Run Mode: ${this.isDryRun ? "enabled" : "disabled"}`
        );

        logger.log(
            `- Disable Post: ${this.state?.TWITTER_ENABLE_POST_GENERATION || this.runtime.getSetting("TWITTER_ENABLE_POST_GENERATION") ? "disabled" : "enabled"}`
        );

        logger.log(
            `- Post Interval: ${this.state?.TWITTER_POST_INTERVAL_MIN || this.runtime.getSetting("TWITTER_POST_INTERVAL_MIN")}-${this.state?.TWITTER_POST_INTERVAL_MAX || this.runtime.getSetting("TWITTER_POST_INTERVAL_MAX")} minutes`
        );
        logger.log(
            `- Post Immediately: ${
                this.state?.TWITTER_POST_IMMEDIATELY || this.runtime.getSetting("TWITTER_POST_IMMEDIATELY")
                    ? "enabled"
                    : "disabled"
            }`
        );

        const targetUsers = this.state?.TWITTER_TARGET_USERS || this.runtime.getSetting("TWITTER_TARGET_USERS") as unknown as string[];
        if (targetUsers) {
            logger.log(`- Target Users: ${targetUsers}`);
        }

        if (this.isDryRun) {
            logger.log(
                "Twitter client initialized in dry run mode - no actual tweets should be posted"
            );
        }

        this.start();
    }

    async start() {
        if (!this.client.profile) {
            await this.client.init();
        }

        const generateNewTweetLoop = async () => {
            const lastPost = await this.runtime.cacheManager.get<{
                timestamp: number;
            }>("twitter/" + this.twitterUsername + "/lastPost");

            const lastPostTimestamp = lastPost?.timestamp ?? 0;
            const minMinutes = (this.state?.TWITTER_POST_INTERVAL_MIN || this.runtime.getSetting("TWITTER_POST_INTERVAL_MIN") as number) ?? 90;
            const maxMinutes = (this.state?.TWITTER_POST_INTERVAL_MAX || this.runtime.getSetting("TWITTER_POST_INTERVAL_MAX") as number) ?? 180;
            const randomMinutes =
                Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) +
                minMinutes;
            const delay = randomMinutes * 60 * 1000;

            if (Date.now() > lastPostTimestamp + delay) {
                await this.generateNewTweet();
            }

            setTimeout(() => {
                generateNewTweetLoop(); // Set up next iteration
            }, delay);

            logger.log(`Next tweet scheduled in ${randomMinutes} minutes`);
        };

        if (this.state?.TWITTER_ENABLE_POST_GENERATION || this.runtime.getSetting("TWITTER_ENABLE_POST_GENERATION")) {
            if (this.state?.TWITTER_POST_IMMEDIATELY || this.runtime.getSetting("TWITTER_POST_IMMEDIATELY")) {
                // generate in 5 seconds
                setTimeout(() => {
                    this.generateNewTweet();
                }, 5000);
            }
            
            generateNewTweetLoop();
            logger.log("Tweet generation loop started");
        }
    }

    createTweetObject(
        tweetResult: any,
        client: any,
        twitterUsername: string
    ): Tweet {
        return {
            id: tweetResult.rest_id,
            name: client.profile.screenName,
            username: client.profile.username,
            text: tweetResult.legacy.full_text,
            conversationId: tweetResult.legacy.conversation_id_str,
            createdAt: tweetResult.legacy.created_at,
            timestamp: new Date(tweetResult.legacy.created_at).getTime(),
            userId: client.profile.id,
            inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
            permanentUrl: `https://twitter.com/${twitterUsername}/status/${tweetResult.rest_id}`,
            hashtags: [],
            mentions: [],
            photos: [],
            thread: [],
            urls: [],
            videos: [],
        } as Tweet;
    }

    async processAndCacheTweet(
        runtime: IAgentRuntime,
        client: ClientBase,
        tweet: Tweet,
        roomId: UUID,
        rawTweetContent: string
    ) {
        // Cache the last post details
        await runtime.cacheManager.set(
            `twitter/${client.profile.username}/lastPost`,
            {
                id: tweet.id,
                timestamp: Date.now(),
            }
        );

        // Cache the tweet
        await client.cacheTweet(tweet);

        // Log the posted tweet
        logger.log(`Tweet posted:\n ${tweet.permanentUrl}`);

        // Ensure the room and participant exist
        await runtime.ensureRoomExists(roomId);
        await runtime.ensureParticipantInRoom(runtime.agentId, roomId);

        // Create a memory for the tweet
        await runtime.messageManager.createMemory({
            id: stringToUuid(tweet.id + "-" + runtime.agentId),
            userId: runtime.agentId,
            agentId: runtime.agentId,
            content: {
                text: rawTweetContent.trim(),
                url: tweet.permanentUrl,
                source: "twitter",
            },
            roomId,
            createdAt: tweet.timestamp,
        });
    }

    async handleNoteTweet(
        client: ClientBase,
        content: string,
        tweetId?: string,
        mediaData?: MediaData[]
    ) {
        try {
            const noteTweetResult = await client.requestQueue.add(
                async () =>
                    await client.twitterClient.sendNoteTweet(
                        content,
                        tweetId,
                        mediaData
                    )
            );

            if (noteTweetResult.errors && noteTweetResult.errors.length > 0) {
                // Note Tweet failed due to authorization. Falling back to standard Tweet.
                const truncateContent = truncateToCompleteSentence(
                    content,
                    280 - 1
                );
                return await this.sendStandardTweet(
                    client,
                    truncateContent,
                    tweetId
                );
            } else {
                return noteTweetResult.data.notetweet_create.tweet_results
                    .result;
            }
        } catch (error) {
            throw new Error(`Note Tweet failed: ${error}`);
        }
    }

    async sendStandardTweet(
        client: ClientBase,
        content: string,
        tweetId?: string,
        mediaData?: MediaData[]
    ) {
        try {
            const standardTweetResult = await client.requestQueue.add(
                async () =>
                    await client.twitterClient.sendTweet(
                        content,
                        tweetId,
                        mediaData
                    )
            );
            const body = await standardTweetResult.json();
            if (!body?.data?.create_tweet?.tweet_results?.result) {
                logger.error("Error sending tweet; Bad response:", body);
                return;
            }
            return body.data.create_tweet.tweet_results.result;
        } catch (error) {
            logger.error("Error sending standard Tweet:", error);
            throw error;
        }
    }

    async postTweet(
        runtime: IAgentRuntime,
        client: ClientBase,
        tweetTextForPosting: string,
        roomId: UUID,
        rawTweetContent: string,
        twitterUsername: string,
        mediaData?: MediaData[]
    ) {
        try {
            logger.log(`Posting new tweet:\n`);

            let result;

            if (tweetTextForPosting.length > 280 - 1) {
                result = await this.handleNoteTweet(
                    client,
                    tweetTextForPosting,
                    undefined,
                    mediaData
                );
            } else {
                result = await this.sendStandardTweet(
                    client,
                    tweetTextForPosting,
                    undefined,
                    mediaData
                );
            }
            const tweet = this.createTweetObject(
                result,
                client,
                twitterUsername
            );

            await this.processAndCacheTweet(
                runtime,
                client,
                tweet,
                roomId,
                rawTweetContent
            );
        } catch (error) {
            logger.error("Error sending tweet:", error);
        }
    }

    /**
     * Generates and posts a new tweet. If isDryRun is true, only logs what would have been posted.
     */
    async generateNewTweet() {
        logger.log("Generating new tweet");

        try {
            const roomId = stringToUuid(
                "twitter_generate_room-" + this.client.profile.username
            );
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.client.profile.username,
                this.runtime.character.name,
                "twitter"
            );

            const topics = this.runtime.character.topics.join(", ");
            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: roomId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: topics || "",
                        action: "TWEET",
                    },
                },
                {
                    twitterUserName: this.client.profile.username
                }
            );

            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.twitterPostTemplate ||
                    twitterPostTemplate,
            });

            logger.debug("generate post prompt:\n" + context);

            const response = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.TEXT_SMALL,
            });

            const rawTweetContent = cleanJsonResponse(response);

            // First attempt to clean content
            let tweetTextForPosting = null;
            let mediaData = null;

            // Try parsing as JSON first
            const parsedResponse = parseJSONObjectFromText(rawTweetContent);
            if (parsedResponse?.text) {
                tweetTextForPosting = parsedResponse.text;
            } else {
                // If not JSON, use the raw text directly
                tweetTextForPosting = rawTweetContent.trim();
            }

            if (
                parsedResponse?.attachments &&
                parsedResponse?.attachments.length > 0
            ) {
                mediaData = await fetchMediaData(parsedResponse.attachments);
            }

            // Try extracting text attribute
            if (!tweetTextForPosting) {
                const parsingText = extractAttributes(rawTweetContent, [
                    "text",
                ]).text;
                if (parsingText) {
                    tweetTextForPosting = truncateToCompleteSentence(
                        extractAttributes(rawTweetContent, ["text"]).text,
                        280 - 1
                    );
                }
            }

            // Use the raw text
            if (!tweetTextForPosting) {
                tweetTextForPosting = rawTweetContent;
            }

            // Truncate the content to the maximum tweet length specified in the environment settings, ensuring the truncation respects sentence boundaries.
                tweetTextForPosting = truncateToCompleteSentence(
                    tweetTextForPosting,
                    280 - 1
                );

            const removeQuotes = (str: string) =>
                str.replace(/^['"](.*)['"]$/, "$1");

            const fixNewLines = (str: string) => str.replaceAll(/\\n/g, "\n\n"); //ensures double spaces

            // Final cleaning
            tweetTextForPosting = removeQuotes(
                fixNewLines(tweetTextForPosting)
            );

            if (this.isDryRun) {
                logger.info(
                    `Dry run: would have posted tweet: ${tweetTextForPosting}`
                );
                return;
            }

            try {
                logger.log(
                    `Posting new tweet:\n ${tweetTextForPosting}`
                );

                this.postTweet(
                    this.runtime,
                    this.client,
                    tweetTextForPosting,
                    roomId,
                    rawTweetContent,
                    this.twitterUsername,
                    mediaData
                );
            } catch (error) {
                logger.error("Error sending tweet:", error);
            }
        } catch (error) {
            logger.error("Error generating new tweet:", error);
        }
    }

    async stop() {
        this.stopProcessingActions = true;
    }
}
