import {
  Action,
  type ActionExample,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  createUniqueUuid,
  ModelType,
} from "@elizaos/core";
import type { TwitterService } from "../services/twitter.service";

export const postTweetAction: Action = {
  name: "POST_TWEET",
  similes: [
    "TWEET",
    "SEND_TWEET",
    "TWITTER_POST",
    "POST_ON_TWITTER",
    "SHARE_ON_TWITTER",
  ],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("twitter");
    return !!service;
  },
  description: "Post a tweet on Twitter",
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: { [key: string]: unknown },
    callback?: HandlerCallback,
  ): Promise<void> => {
    logger.info("Executing POST_TWEET action");

    try {
      // Get the Twitter service instead of creating a new client
      const twitterService = runtime.getService('twitter') as TwitterService;
      
      if (!twitterService) {
        throw new Error("Twitter service not available");
      }

      // Get the initialized client from the service
      const twitterClient = twitterService.twitterClient;
      if (!twitterClient || !twitterClient.client) {
        throw new Error("Twitter client not initialized in service");
      }

      const client = twitterClient.client;

      // Verify we have a profile
      if (!client.profile) {
        throw new Error(
          "Twitter client not properly initialized - no profile found",
        );
      }

      // Get tweet text
      let text = message.content?.text?.trim();
      if (!text) {
        logger.error("No text content for tweet");
        if (callback) {
          callback({
            text: "I need something to tweet! Please provide the text.",
            action: "POST_TWEET",
          });
        }
        return;
      }

      // Truncate if too long
      if (text.length > 280) {
        logger.info(`Truncating tweet from ${text.length} to 280 characters`);
        // Try to truncate at sentence boundary
        const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
        let truncated = "";
        for (const sentence of sentences) {
          if ((truncated + sentence).length <= 280) {
            truncated += sentence;
          } else {
            break;
          }
        }
        text = truncated.trim() || text.substring(0, 277) + "...";
        logger.info(`Truncated tweet: ${text}`);
      }

      // Generate a more natural tweet if the input is too short or generic
      let finalTweetText = text;
      if (
        text.length < 50 ||
        text.toLowerCase().includes("post") ||
        text.toLowerCase().includes("tweet")
      ) {
        const tweetPrompt = `You are ${runtime.character.name}. 
${runtime.character.bio || ''}

CRITICAL: Generate a tweet based on the context that sounds like YOU, not generic corporate speak.

Context: ${text}

${runtime.character.messageExamples && runtime.character.messageExamples.length > 0 ? `
Your voice examples:
${runtime.character.messageExamples.map((example: any) => 
  Array.isArray(example) ? example[1]?.content?.text || '' : example
).filter(Boolean).slice(0, 3).join('\n')}
` : ''}

Style rules:
- Be specific, opinionated, authentic
- No generic motivational content or platitudes
- Share actual insights, hot takes, or unique perspectives
- Keep it conversational and punchy
- Under 280 characters
- Skip hashtags unless essential
- Don't end with generic questions

Your interests: ${runtime.character.topics?.join(", ") || "technology, AI, web3"}
${runtime.character.style ? `Your style: ${
  typeof runtime.character.style === 'object' 
    ? runtime.character.style.all?.join(', ') || ''
    : runtime.character.style
}` : ''}

Tweet:`;

        const response = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: tweetPrompt,
          max_tokens: 100,
          temperature: 0.9, // Higher for more creativity
        });

        finalTweetText = response.trim();
      }

      // Post the tweet
      const result = await client.twitterClient.sendTweet(finalTweetText);

      if (result && result.data) {
        const tweetData = result.data.data || result.data;
        // Extract tweet ID from the response - handle different response formats
        let tweetId: string;
        if ("id" in tweetData) {
          tweetId = tweetData.id;
        } else if ((tweetData as any).data?.id) {
          tweetId = (tweetData as any).data.id;
        } else {
          tweetId = Date.now().toString();
        }
        const tweetUrl = `https://twitter.com/${client.profile.username}/status/${tweetId}`;

        logger.info(`Successfully posted tweet: ${tweetId}`);

        // Create memory of the posted tweet with error handling
        try {
          await runtime.createMemory(
            {
              entityId: runtime.agentId,
              content: {
                text: finalTweetText,
                url: tweetUrl,
                source: "twitter",
                action: "POST_TWEET",
              },
              roomId: message.roomId,
            },
            "messages",
          );
        } catch (memoryError) {
          logger.error("Failed to create memory for posted tweet:", memoryError);
          // Don't fail the action if memory creation fails
        }

        if (callback) {
          await callback({
            text: `I've posted a tweet: "${finalTweetText}"\n\nView it here: ${tweetUrl}`,
            metadata: {
              tweetId: tweetId,
              tweetUrl,
            },
          });
        }

        return;
      } else {
        throw new Error("Failed to post tweet - no response data");
      }
    } catch (error) {
      logger.error("Error posting tweet:", error);

      if (callback) {
        await callback({
          text: `Sorry, I couldn't post the tweet. Error: ${error.message}`,
          metadata: { error: error.message },
        });
      }

      return;
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Post a tweet about the weather today",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll post a tweet about today's weather for you.",
          action: "POST_TWEET",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Tweet: The future of AI is collaborative intelligence",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll post that tweet for you.",
          action: "POST_TWEET",
        },
      },
    ],
  ] as ActionExample[][],
};
