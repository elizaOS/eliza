import {
  ChannelType,
  composePrompt,
  type Content,
  createUniqueUuid,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelTypes,
  parseJSONObjectFromText,
} from "@elizaos/core";
import type { ClientBase } from "./base.ts";
import { SearchMode, type Tweet } from "./client/index.ts";
import { buildConversationThread, sendTweet, wait } from "./utils.ts";

export const twitterMessageHandlerTemplate = `# Task: Generate dialog and actions for {{agentName}}.
{{providers}}
Here is the current post text again. Remember to include an action if the current post text includes a prompt that asks for one of the available actions mentioned above (does not need to be exact)
{{currentPost}}
{{imageDescriptions}}

# Instructions: Write the next message for {{agentName}}. Include the appropriate action from the list: {{actionNames}}
Response format should be formatted in a valid JSON block like this:
\`\`\`json
{ "thought": "<string>", "name": "{{agentName}}", "text": "<string>", "action": "<string>" }
\`\`\`

The "action" field should be one of the options in [Available Actions] and the "text" field should be the response you want to send. Do not including any thinking or internal reflection in the "text" field. "thought" should be a short description of what the agent is thinking about before responding, inlcuding a brief justification for the response.`;

export const twitterShouldRespondTemplate = `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP.

For other users:
- {{agentName}} should RESPOND to messages directed at them
- {{agentName}} should RESPOND to conversations relevant to their background
- {{agentName}} should IGNORE irrelevant messages
- {{agentName}} should IGNORE very short messages unless directly addressed
- {{agentName}} should STOP if asked to stop
- {{agentName}} should STOP if conversation is concluded
- {{agentName}} is in a room with other users and wants to be conversational, but not annoying.

IMPORTANT:
- {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.
- For users not in the priority list, {{agentName}} (@{{twitterUserName}}) should err on the side of IGNORE rather than RESPOND if in doubt.

Recent Posts:
{{recentPosts}}

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Respond with RESPOND if {{agentName}} should respond, or IGNORE if {{agentName}} should not respond to the last message and STOP if {{agentName}} should stop participating in the conversation.
The available options are RESPOND, IGNORE, or STOP. Choose the most appropriate option.`;

export class TwitterInteractionClient {
  client: ClientBase;
  runtime: IAgentRuntime;
  private isDryRun: boolean;
  private state: any;
  constructor(client: ClientBase, runtime: IAgentRuntime, state: any) {
    this.client = client;
    this.runtime = runtime;
    this.state = state;
    this.isDryRun =
      this.state?.TWITTER_DRY_RUN ||
      (this.runtime.getSetting("TWITTER_DRY_RUN") as unknown as boolean);
  }

  async start() {
    const handleTwitterInteractionsLoop = () => {
      // Defaults to 2 minutes
      const interactionInterval =
        (this.state?.TWITTER_POLL_INTERVAL ||
          (this.runtime.getSetting(
            "TWITTER_POLL_INTERVAL"
          ) as unknown as number) ||
          120) * 1000;

      this.handleTwitterInteractions();
      setTimeout(handleTwitterInteractionsLoop, interactionInterval);
    };
    handleTwitterInteractionsLoop();
  }

  async handleTwitterInteractions() {
    logger.log("Checking Twitter interactions");

    const twitterUsername = this.client.profile?.username;
    try {
      // Check for mentions
      const mentionCandidates = (
        await this.client.fetchSearchTweets(
          `@${twitterUsername}`,
          20,
          SearchMode.Latest
        )
      ).tweets;

      logger.log(
        "Completed checking mentioned tweets:",
        mentionCandidates.length
      );
      let uniqueTweetCandidates = [...mentionCandidates];

      // Sort tweet candidates by ID in ascending order
      uniqueTweetCandidates = uniqueTweetCandidates
        .sort((a, b) => a.id.localeCompare(b.id))
        .filter((tweet) => tweet.userId !== this.client.profile.id);

      // for each tweet candidate, handle the tweet
      for (const tweet of uniqueTweetCandidates) {
        if (
          !this.client.lastCheckedTweetId ||
          BigInt(tweet.id) > this.client.lastCheckedTweetId
        ) {
          // Generate the tweetId UUID the same way it's done in handleTweet
          const tweetId = createUniqueUuid(this.runtime, tweet.id);

          // Check if we've already processed this tweet
          const existingResponse = await this.runtime
            .getMemoryManager("messages")
            .getMemoryById(tweetId);

          if (existingResponse) {
            logger.log(`Already responded to tweet ${tweet.id}, skipping`);
            continue;
          }
          logger.log("New Tweet found", tweet.permanentUrl);

          const roomId = createUniqueUuid(this.runtime, tweet.conversationId);

          const entityId = createUniqueUuid(
            this.runtime,
            tweet.userId === this.client.profile.id
              ? this.runtime.agentId
              : tweet.userId
          );

          await this.runtime.ensureConnection({
            entityId,
            roomId,
            userName: tweet.username,
            name: tweet.name,
            source: "twitter",
            type: ChannelType.GROUP,
          });

          const thread = await buildConversationThread(tweet, this.client);

          const message = {
            content: {
              text: tweet.text,
              imageUrls: tweet.photos?.map((photo) => photo.url) || [],
              tweet: tweet,
              source: "twitter",
            },
            agentId: this.runtime.agentId,
            entityId,
            roomId,
          };

          await this.handleTweet({
            tweet,
            message,
            thread,
          });

          // Update the last checked tweet ID after processing each tweet
          this.client.lastCheckedTweetId = BigInt(tweet.id);
        }
      }

      // Save the latest checked tweet ID to the file
      await this.client.cacheLatestCheckedTweetId();

      logger.log("Finished checking Twitter interactions");
    } catch (error) {
      logger.error("Error handling Twitter interactions:", error);
    }
  }

  async handleTweet({
    tweet,
    message,
    thread,
  }: {
    tweet: Tweet;
    message: Memory;
    thread: Tweet[];
  }) {
    if (!message.content.text) {
      logger.log("Skipping Tweet with no text", tweet.id);
      return { text: "", actions: ["IGNORE"] };
    }

    logger.log("Processing Tweet: ", tweet.id);
    const formatTweet = (tweet: Tweet) => {
      return `  ID: ${tweet.id}
  From: ${tweet.name} (@${tweet.username})
  Text: ${tweet.text}`;
    };
    const currentPost = formatTweet(tweet);

    const formattedConversation = thread
      .map(
        (tweet) => `@${tweet.username} (${new Date(
          tweet.timestamp * 1000
        ).toLocaleString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          month: "short",
          day: "numeric",
        })}):
        ${tweet.text}`
      )
      .join("\n\n");

    const imageDescriptionsArray = [];
    try {
      for (const photo of tweet.photos) {
        const description = await this.runtime.useModel(
          ModelTypes.IMAGE_DESCRIPTION,
          photo.url
        );
        imageDescriptionsArray.push(description);
      }
    } catch (error) {
      // Handle the error
      logger.error("Error Occured during describing image: ", error);
    }

    let state = await this.runtime.composeState(message);

    state.values = {
      ...state.values,
      twitterUserName:
        this.state?.TWITTER_USERNAME ||
        this.runtime.getSetting("TWITTER_USERNAME"),
      currentPost, // TODO: move to recentMessages provider
      formattedConversation,
    };
    // check if the tweet exists, save if it doesn't
    const tweetId = createUniqueUuid(this.runtime, tweet.id);
    const tweetExists = await this.runtime
      .getMemoryManager("messages")
      .getMemoryById(tweetId);

    if (!tweetExists) {
      logger.log("tweet does not exist, saving");
      const entityId = createUniqueUuid(this.runtime, tweet.userId);

      const roomId = createUniqueUuid(this.runtime, tweet.conversationId);

      await this.runtime.ensureConnection({
        entityId,
        roomId,
        userName: tweet.username,
        name: tweet.name,
        source: "twitter",
        type: ChannelType.GROUP,
      });

      const message = {
        id: tweetId,
        agentId: this.runtime.agentId,
        content: {
          text: tweet.text,
          url: tweet.permanentUrl,
          imageUrls: tweet.photos?.map((photo) => photo.url) || [],
          inReplyTo: tweet.inReplyToStatusId
            ? createUniqueUuid(this.runtime, tweet.inReplyToStatusId)
            : undefined,
        },
        entityId,
        roomId,
        createdAt: tweet.timestamp * 1000,
      };
      this.client.saveRequestMessage(message, state);
    }

    const shouldRespondPrompt = composePrompt({
      state,
      template:
        this.runtime.character.templates?.twitterShouldRespondTemplate ||
        this.runtime.character?.templates?.shouldRespondTemplate ||
        twitterShouldRespondTemplate,
    });

    const shouldRespond = await this.runtime.useModel(ModelTypes.TEXT_SMALL, {
      prompt: shouldRespondPrompt,
    });

    if (!shouldRespond.includes("RESPOND")) {
      logger.log("Not responding to message");
      return { text: "Response Decision:", action: shouldRespond };
    }

    const prompt = composePrompt({
      state: {
        ...state,
        // Convert actionNames array to string
        actionNames: Array.isArray(state.actionNames)
          ? state.actionNames.join(", ")
          : state.actionNames || "",
        actions: Array.isArray(state.actions)
          ? state.actions.join("\n")
          : state.actions || "",
        // Ensure character examples are included
        characterPostExamples: this.runtime.character.messageExamples
          ? this.runtime.character.messageExamples
              .map((example) =>
                example
                  .map(
                    (msg) =>
                      `${msg.name}: ${msg.content.text}${
                        msg.content.actions
                          ? ` (Actions: ${msg.content.actions.join(", ")})`
                          : ""
                      }`
                  )
                  .join("\n")
              )
              .join("\n\n")
          : "",
      },
      template:
        this.runtime.character.templates?.twitterMessageHandlerTemplate ||
        this.runtime.character?.templates?.messageHandlerTemplate ||
        twitterMessageHandlerTemplate,
    });

    const responseText = await this.runtime.useModel(ModelTypes.TEXT_LARGE, {
      prompt,
    });

    const response = parseJSONObjectFromText(responseText) as Content;

    const removeQuotes = (str: string) => str.replace(/^['"](.*)['"]$/, "$1");

    const replyToId = createUniqueUuid(this.runtime, tweet.id);

    response.inReplyTo = replyToId;

    response.text = removeQuotes(response.text);

    if (response.text) {
      if (this.isDryRun) {
        logger.info(
          `Dry run: Selected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`
        );
      } else {
        try {
          const callback: HandlerCallback = async (
            response: Content,
            tweetId?: string
          ) => {
            const memories = await sendTweet(
              this.client,
              response,
              message.roomId,
              this.state?.TWITTER_USERNAME ||
                (this.runtime.getSetting("TWITTER_USERNAME") as string),
              tweetId || tweet.id
            );
            return memories;
          };

          const responseMessages = [
            {
              id: createUniqueUuid(this.runtime, tweet.id),
              entityId: this.runtime.agentId,
              agentId: this.runtime.agentId,
              content: response,
              roomId: message.roomId,
              createdAt: Date.now(),
            },
          ];

          state = await this.runtime.composeState(message, ["RECENT_MESSAGES"]);

          for (const responseMessage of responseMessages) {
            await this.runtime
              .getMemoryManager("messages")
              .createMemory(responseMessage);
          }

          const responseTweetId = (
            responseMessages[responseMessages.length - 1]?.content as any
          )?.tweetId;

          await this.runtime.processActions(
            message,
            responseMessages,
            state,
            (response: Content) => {
              return callback(response, responseTweetId);
            }
          );

          const responseInfo = `Context:\n\n${prompt}\n\nSelected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`;

          await this.runtime.getDatabaseAdapter().setCache<string>(
            `twitter/tweet_generation_${tweet.id}.txt`,
            responseInfo
          );
          await wait();
        } catch (error) {
          logger.error(`Error sending response tweet: ${error}`);
        }
      }
    }
  }

  async buildConversationThread(
    tweet: Tweet,
    maxReplies = 10
  ): Promise<Tweet[]> {
    const thread: Tweet[] = [];
    const visited: Set<string> = new Set();

    async function processThread(currentTweet: Tweet, depth = 0) {
      logger.log("Processing tweet:", {
        id: currentTweet.id,
        inReplyToStatusId: currentTweet.inReplyToStatusId,
        depth: depth,
      });

      if (!currentTweet) {
        logger.log("No current tweet found for thread building");
        return;
      }

      if (depth >= maxReplies) {
        logger.log("Reached maximum reply depth", depth);
        return;
      }

      // Handle memory storage
      const memory = await this.runtime
        .getMemoryManager("messages")
        .getMemoryById(createUniqueUuid(this.runtime, currentTweet.id));
      if (!memory) {
        const roomId = createUniqueUuid(this.runtime, tweet.conversationId);
        const entityId = createUniqueUuid(this.runtime, currentTweet.userId);

        await this.runtime.ensureConnection({
          entityId,
          roomId,
          userName: currentTweet.username,
          name: currentTweet.name,
          source: "twitter",
          type: ChannelType.GROUP,
        });

        this.runtime.getMemoryManager("messages").createMemory({
          id: createUniqueUuid(this.runtime, currentTweet.id),
          agentId: this.runtime.agentId,
          content: {
            text: currentTweet.text,
            source: "twitter",
            url: currentTweet.permanentUrl,
            imageUrls: currentTweet.photos?.map((photo) => photo.url) || [],
            inReplyTo: currentTweet.inReplyToStatusId
              ? createUniqueUuid(this.runtime, currentTweet.inReplyToStatusId)
              : undefined,
          },
          createdAt: currentTweet.timestamp * 1000,
          roomId,
          entityId:
            currentTweet.userId === this.twitterUserId
              ? this.runtime.agentId
              : createUniqueUuid(this.runtime, currentTweet.userId),
        });
      }

      if (visited.has(currentTweet.id)) {
        logger.log("Already visited tweet:", currentTweet.id);
        return;
      }

      visited.add(currentTweet.id);
      thread.unshift(currentTweet);

      if (currentTweet.inReplyToStatusId) {
        logger.log("Fetching parent tweet:", currentTweet.inReplyToStatusId);
        try {
          const parentTweet = await this.twitterClient.getTweet(
            currentTweet.inReplyToStatusId
          );

          if (parentTweet) {
            logger.log("Found parent tweet:", {
              id: parentTweet.id,
              text: parentTweet.text?.slice(0, 50),
            });
            await processThread(parentTweet, depth + 1);
          } else {
            logger.log(
              "No parent tweet found for:",
              currentTweet.inReplyToStatusId
            );
          }
        } catch (error) {
          logger.log("Error fetching parent tweet:", {
            tweetId: currentTweet.inReplyToStatusId,
            error,
          });
        }
      } else {
        logger.log("Reached end of reply chain at:", currentTweet.id);
      }
    }

    // Need to bind this prompt for the inner function
    await processThread.bind(this)(tweet, 0);

    return thread;
  }
}
