import { SearchMode } from "agent-twitter-client";
import fs from "fs";
import { composeContext, Memory } from "@ai16z/eliza";
import { generateMessageResponse, generateText } from "@ai16z/eliza";
import { messageCompletionFooter } from "@ai16z/eliza";
import {
    Content,
    HandlerCallback,
    IAgentRuntime,
    ModelClass,
    State,
    ServiceType,
    IImageDescriptionService,
} from "@ai16z/eliza";

import { stringToUuid } from "@ai16z/eliza";
import { ClientBase } from "./base.ts";
import { buildConversationThread, sendTweet, wait } from "./utils.ts";
import { elizaLogger } from "@ai16z/eliza";

const twitterSearchTemplate =
    `{{relevantFacts}}
{{recentFacts}}

{{timeline}}

{{providers}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{postDirections}}

{{recentPosts}}

# Task: Respond to the following post in the style and perspective of {{agentName}} (aka @{{twitterUserName}}). Write a {{adjective}} response for {{agentName}} to say directly in response to the post. don't generalize.
{{currentPost}}

IMPORTANT: Your response CANNOT be longer than 20 words.
Aim for 1-2 short sentences maximum. Be concise and direct.

Your response should not contain any questions. Brief, concise statements only. No emojis. Use \\n\\n (double spaces) between statements.

` + messageCompletionFooter;

export class TwitterViralClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    private respondedTweets: Set<string> = new Set();
    private isEngaging: boolean = false;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
    }

    async start(postImmediately: boolean = false) {
        await this.viralTweetsLoop();
    }

    private async viralTweetsLoop() {
        if (this.isEngaging) return;

        try {
            this.isEngaging = true;
            await this.engageWithViralTweets();
        } finally {
            this.isEngaging = false;
        }

        setTimeout(() => this.viralTweetsLoop(), 12 * 60 * 60 * 1000);
    }

    private async engageWithViralTweets() {
        elizaLogger.log("=== VIRAL TWEETS LOOP START ===");
        elizaLogger.log("=== VIRAL TWEETS LOOP START ===");
        elizaLogger.log("=== VIRAL TWEETS LOOP START ===");
        elizaLogger.log("=== VIRAL TWEETS LOOP START ===");
        elizaLogger.log("=== VIRAL TWEETS LOOP START ===");
        elizaLogger.log("=== VIRAL TWEETS LOOP START ===");
        elizaLogger.log("=== VIRAL TWEETS LOOP START ===");
        try {
            if (!fs.existsSync("tweetcache")) {
                fs.mkdirSync("tweetcache");
            }

            // Get yesterday's date
            const date = new Date();
            date.setDate(date.getDate() - 1);
            const formattedDate = date.toISOString().split("T")[0];
            elizaLogger.log(
                `Searching for viral tweets since: ${formattedDate}`
            );

            const recentTweets = await this.client.fetchSearchTweets(
                `min_faves:1000 since: ${formattedDate}`,
                20,
                SearchMode.Top
            );

            elizaLogger.log(`Found ${recentTweets.tweets.length} viral tweets`);

            // randomly slice .tweets down to 20
            const slicedTweets = recentTweets.tweets
                .sort(() => Math.random() - 0.5)
                .slice(0, 20);

            if (slicedTweets.length === 0) {
                elizaLogger.error("No viral tweets found");
                return;
            }

            const prompt = `
Here are some viral tweets from the last 3 hours:

${slicedTweets
    .filter((tweet) => {
        // ignore tweets where any of the thread tweets contain a tweet by the bot
        const thread = tweet.thread;
        const botTweet = thread.find(
            (t) => t.username === this.runtime.getSetting("TWITTER_USERNAME")
        );
        return !botTweet;
    })
    .map(
        (tweet) => `
ID: ${tweet.id}${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}
From: ${tweet.name} (@${tweet.username})
Text: ${tweet.text}
`
    )
    .join("\n")}

Which tweet is the most interesting and relevant for ${this.runtime.character.name} to reply to? Please provide only the ID of the tweet in your response.
Notes:
  - Respond to English tweets only
  - Respond to tweets that don't have a lot of hashtags, links, URLs or images
  - Respond to tweets that are not retweets
  - Respond to tweets where there is an easy exchange of ideas to have with the user
  - ONLY respond with the ID of the tweet`;

            const mostInterestingTweetResponse = await generateText({
                runtime: this.runtime,
                context: prompt,
                modelClass: ModelClass.LARGE,
            });

            const tweetId = mostInterestingTweetResponse.trim();
            const selectedTweet = slicedTweets.find(
                (tweet) =>
                    tweet.id.toString().includes(tweetId) ||
                    tweetId.includes(tweet.id.toString())
            );

            if (!selectedTweet) {
                console.log("No matching tweet found for the selected ID");
                return console.log("Selected tweet ID:", tweetId);
            }

            console.log("Selected tweet to reply to:", selectedTweet?.text);

            if (
                selectedTweet.username ===
                this.runtime.getSetting("TWITTER_USERNAME")
            ) {
                console.log("Skipping tweet from bot itself");
                return;
            }
            if (await this.client.hasRespondedToTweet(selectedTweet.id)) {
                console.log(
                    `Already responded to tweet ${selectedTweet.id}, skipping`
                );
                return;
            }
            const conversationId = selectedTweet.conversationId;
            const roomId = stringToUuid(
                conversationId + "-" + this.runtime.agentId
            );

            const userIdUUID = stringToUuid(selectedTweet.userId as string);

            await this.runtime.ensureConnection(
                userIdUUID,
                roomId,
                selectedTweet.username,
                selectedTweet.name,
                "twitter"
            );

            // crawl additional conversation tweets, if there are any
            await buildConversationThread(selectedTweet, this.client);

            const message = {
                id: stringToUuid(selectedTweet.id + "-" + this.runtime.agentId),
                agentId: this.runtime.agentId,
                content: {
                    text: selectedTweet.text,
                    url: selectedTweet.permanentUrl,
                    inReplyTo: selectedTweet.inReplyToStatusId
                        ? stringToUuid(
                              selectedTweet.inReplyToStatusId +
                                  "-" +
                                  this.runtime.agentId
                          )
                        : undefined,
                },
                userId: userIdUUID,
                roomId,
                // Timestamps are in seconds, but we need them in milliseconds
                createdAt: selectedTweet.timestamp * 1000,
            };

            if (!message.content.text) {
                return { text: "", action: "IGNORE" };
            }

            // Fetch replies and retweets
            const replies = selectedTweet.thread;
            const replyContext = replies
                .filter(
                    (reply) =>
                        reply.username !==
                        this.runtime.getSetting("TWITTER_USERNAME")
                )
                .map((reply) => `@${reply.username}: ${reply.text}`)
                .join("\n");

            let tweetBackground = "";
            if (selectedTweet.isRetweet) {
                const originalTweet = await this.client.requestQueue.add(() =>
                    this.client.twitterClient.getTweet(selectedTweet.id)
                );
                tweetBackground = `Retweeting @${originalTweet.username}: ${originalTweet.text}`;
            }

            // Generate image descriptions using GPT-4 vision API
            const imageDescriptions = [];
            for (const photo of selectedTweet.photos) {
                const description = await this.runtime
                    .getService<IImageDescriptionService>(
                        ServiceType.IMAGE_DESCRIPTION
                    )
                    .describeImage(photo.url);
                imageDescriptions.push(description);
            }

            // Get quoted content if it exists
            const quotedContent =
                await this.client.getQuotedContent(selectedTweet);

            let state = await this.runtime.composeState(message, {
                twitterClient: this.client.twitterClient,
                twitterUserName: this.runtime.getSetting("TWITTER_USERNAME"),
                tweetContext: `${tweetBackground}

                Original Post:
                By @${selectedTweet.username}
                ${selectedTweet.text}${replyContext.length > 0 && `\nReplies to original post:\n${replyContext}`}
                ${`Original post text: ${selectedTweet.text}`}
                ${selectedTweet.urls.length > 0 ? `URLs: ${selectedTweet.urls.join(", ")}\n` : ""}${imageDescriptions.length > 0 ? `\nImages in Post (Described): ${imageDescriptions.join(", ")}\n` : ""}
                ${quotedContent ? `\ncritical quoted content from the tweet you are responding to:\n${quotedContent}` : ""}
                `,
            });

            await this.client.saveRequestMessage(message, state as State);

            const context = composeContext({
                state,
                template: twitterSearchTemplate,
            });

            const responseContent = await generateMessageResponse({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.LARGE,
            });

            responseContent.inReplyTo = message.id;

            const response = responseContent;

            if (!response.text) {
                console.log("Returning: No response text found");
                return;
            }

            console.log(
                `Bot would respond to tweet ${selectedTweet.id} with: ${response.text}`
            );
            try {
                const callback: HandlerCallback = async (response: Content) => {
                    const memories = await sendTweet(
                        this.client,
                        response,
                        message.roomId,
                        this.runtime.getSetting("TWITTER_USERNAME"),
                        tweetId
                    );
                    return memories;
                };

                const responseMessages = await callback(responseContent);

                state = await this.runtime.updateRecentMessageState(state);

                for (const responseMessage of responseMessages) {
                    await this.runtime.messageManager.createMemory(
                        responseMessage,
                        false
                    );
                }

                state = await this.runtime.updateRecentMessageState(state);

                await this.runtime.evaluate(message, state);
                await this.runtime.processActions(
                    message,
                    responseMessages,
                    state,
                    callback
                );

                this.respondedTweets.add(selectedTweet.id);
                const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${selectedTweet.id} - ${selectedTweet.username}: ${selectedTweet.text}\nAgent's Output:\n${response.text}`;
                const debugFileName = `tweetcache/tweet_generation_${selectedTweet.id}.txt`;

                fs.writeFileSync(debugFileName, responseInfo);
                await wait();
            } catch (error) {
                console.error(`Error sending response post: ${error}`);
            }

            const memory = {
                id: stringToUuid(selectedTweet.id + "-" + this.runtime.agentId),
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                content: {
                    text: response.text,
                    url: response.url,
                    source: "twitter",
                },
            } as Memory;
            await this.runtime.messageManager.addEmbeddingToMemory(memory);
            await this.runtime.messageManager.createMemory(memory);
        } catch (error) {
            elizaLogger.error("Error in viral tweets loop:", error);
        } finally {
            elizaLogger.log("=== VIRAL TWEETS LOOP END ===");
            elizaLogger.log("=== VIRAL TWEETS LOOP END ===");
            elizaLogger.log("=== VIRAL TWEETS LOOP END ===");
            elizaLogger.log("=== VIRAL TWEETS LOOP END ===");
            elizaLogger.log("=== VIRAL TWEETS LOOP END ===");
            elizaLogger.log("=== VIRAL TWEETS LOOP END ===");
            elizaLogger.log("=== VIRAL TWEETS LOOP END ===");
        }
    }
}
