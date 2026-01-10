import {
  Action,
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  ModelType,
} from "@elizaos/core";
import type { XService } from "../services/x.service";

export const postAction: Action = {
  name: "POST",
  similes: ["POST_TO_X", "TWEET", "SEND_POST", "SHARE_ON_X"],
  description: "Post content on X (Twitter)",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const service = runtime.getService("x");
    return !!service;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    logger.info("Executing POST action");

    const xService = runtime.getService("x") as XService;
    if (!xService?.xClient?.client) {
      throw new Error("X service not available");
    }

    const client = xService.xClient.client;
    if (!client.profile) {
      throw new Error("X client not initialized - no profile");
    }

    let text = message.content?.text?.trim();
    if (!text) {
      if (callback) {
        callback({
          text: "I need something to post! Please provide the text.",
          action: "POST",
        });
      }
      return { success: false, error: "No text provided" };
    }

    // Truncate if too long
    if (text.length > 280) {
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
    }

    // Generate natural post if input is short/generic
    let finalText = text;
    if (text.length < 50 || text.toLowerCase().includes("post") || text.toLowerCase().includes("tweet")) {
      const prompt = `You are ${runtime.character.name}.
${runtime.character.bio || ""}

Generate a post based on: ${text}

Style:
- Be specific, opinionated, authentic
- No generic content or platitudes
- Share insights, hot takes, unique perspectives
- Conversational and punchy
- Under 280 characters
- Skip hashtags unless essential

Topics: ${runtime.character.topics?.join(", ") || "technology, AI"}

Post:`;

      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        maxTokens: 100,
        temperature: 0.9,
      });

      finalText = String(response).trim();
    }

    const result = await client.xClient.sendPost(finalText);

    if (result?.data) {
      const postData = result.data.data || result.data;
      const postId = postData.id || Date.now().toString();
      const postUrl = `https://x.com/${client.profile.username}/status/${postId}`;

      logger.info(`Posted: ${postId}`);

      await runtime.createMemory(
        {
          entityId: runtime.agentId,
          content: {
            text: finalText,
            url: postUrl,
            source: "x",
            action: "POST",
          },
          roomId: message.roomId,
        },
        "messages"
      );

      if (callback) {
        await callback({
          text: `Posted: "${finalText}"\n\n${postUrl}`,
          metadata: { postId, postUrl },
        });
      }
      return { success: true, text: `Posted: ${postUrl}` };
    } else {
      throw new Error("Failed to post - no response data");
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Post about the weather today" },
      },
      {
        name: "{{agent}}",
        content: { text: "I'll post about today's weather.", action: "POST" },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Post: The future of AI is collaborative intelligence" },
      },
      {
        name: "{{agent}}",
        content: { text: "I'll post that for you.", action: "POST" },
      },
    ],
  ] as ActionExample[][],
};
