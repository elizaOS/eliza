import {
  type Action,
  type ActionExample,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import type { TwitterService } from "../services/x.service";
import {
  terminalActionInteractionSemantics,
  terminalActionResultData,
} from "./actionResultSemantics.js";

export const postTweetAction: Action = {
  name: "POST_TWEET",
  similes: [
    "TWEET",
    "SEND_TWEET",
    "TWITTER_POST",
    "POST_ON_TWITTER",
    "SHARE_ON_TWITTER",
  ],
  ...terminalActionInteractionSemantics,
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
  ): Promise<boolean> => {
    const __avTextRaw =
      typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["tweet", "twitter", "post", "share"];
    const __avKeywordOk =
      (__avKeywords.length > 0 &&
        __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw))) ||
      String((message?.content as { source?: string })?.source ?? "") ===
        "twitter";
    const __avRegex = /\b(?:tweet|twitter|post|share)\b/i;
    const __avRegexOk =
      __avRegex.test(__avText) ||
      String((message?.content as { source?: string })?.source ?? "") ===
        "twitter";
    const __avSource = String(
      (message?.content as { source?: string })?.source ?? "",
    );
    const __avExpectedSource = "";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    const __avOptions = options && typeof options === "object" ? options : {};
    const __avInputOk =
      __avText.trim().length > 0 ||
      Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
      Boolean(message?.content && typeof message.content === "object") ||
      String((message?.content as { source?: string })?.source ?? "") ===
        "twitter";

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (
      runtime: IAgentRuntime,
      _message: Memory,
    ): Promise<boolean> => {
      const service = runtime.getService("x") ?? runtime.getService("twitter");
      return !!service;
    };
    try {
      return Boolean(await __avLegacyValidate(runtime, message));
    } catch {
      return false;
    }
  },
  description: "Post a tweet on Twitter",
  descriptionCompressed: "Post tweet.",
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ) => {
    logger.info("Executing POST_TWEET action");

    try {
      const twitterService = (runtime.getService("x") ??
        runtime.getService("twitter")) as TwitterService | null;

      if (!twitterService) {
        throw new Error("X service not available");
      }

      // Get the initialized client from the service
      const twitterClient = twitterService.twitterClient;
      if (!twitterClient?.client) {
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
        return { success: false, text: "No text content for tweet" };
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
        text = truncated.trim() || `${text.substring(0, 277)}...`;
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
${runtime.character.bio || ""}

CRITICAL: Generate a tweet based on the context that sounds like YOU, not generic corporate speak.

Context: ${text}

${
  runtime.character.messageExamples &&
  runtime.character.messageExamples.length > 0
    ? `
Your voice examples:
${runtime.character.messageExamples
  .map((example) =>
    Array.isArray(example) ? example[1]?.content?.text || "" : example,
  )
  .filter(Boolean)
  .slice(0, 3)
  .join("\n")}
`
    : ""
}

Style rules:
- Be specific, opinionated, authentic
- No generic motivational content or platitudes
- Share actual insights, hot takes, or unique perspectives
- Keep it conversational and punchy
- Under 280 characters
- Skip hashtags unless essential
- Don't end with generic questions

Your interests: ${runtime.character.topics?.join(", ") || "technology, AI, web3"}
${
  runtime.character.style
    ? `Your style: ${
        typeof runtime.character.style === "object"
          ? runtime.character.style.all?.join(", ") || ""
          : runtime.character.style
      }`
    : ""
}

Tweet:`;

        const response = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: tweetPrompt,
          maxTokens: 100,
          temperature: 0.9, // Higher for more creativity
        });

        finalTweetText = response.trim();
      }

      // Post the tweet
      const result = await client.twitterClient.sendTweet(finalTweetText);

      if (result?.data) {
        const tweetData = result.data.data || result.data;
        // Extract tweet ID from the response - handle different response formats
        let tweetId: string;
        if ("id" in tweetData) {
          tweetId = tweetData.id;
        } else if (
          typeof (tweetData as { data?: { id?: unknown } }).data?.id ===
          "string"
        ) {
          tweetId = (tweetData as { data: { id: string } }).data.id;
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
          const memoryErrorMessage =
            memoryError instanceof Error
              ? memoryError.message
              : String(memoryError);
          logger.error(
            `[POST_TWEET] Failed to create memory for posted tweet: ${memoryErrorMessage}`,
          );
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

        return {
          success: true,
          text: finalTweetText,
          data: terminalActionResultData({ tweetId, tweetUrl }),
        };
      } else {
        throw new Error("Failed to post tweet - no response data");
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(`[POST_TWEET] Error posting tweet: ${errorMessage}`);

      if (callback) {
        await callback({
          text: `Sorry, I couldn't post the tweet. Error: ${errorMessage}`,
          metadata: { error: errorMessage },
        });
      }

      return { success: false, text: errorMessage || "Failed to post tweet" };
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
