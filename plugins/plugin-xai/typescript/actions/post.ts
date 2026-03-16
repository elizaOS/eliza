import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { XService } from "../services/x.service";
import { sendPost } from "../utils";

const spec = requireActionSpec("POST");

export const postAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const service = runtime.getService("x");
    return !!service;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
    _responses?: Memory[]
  ): Promise<ActionResult> => {
    logger.info("Executing POST action");

    const xService = runtime.getService("x") as XService;
    if (!xService?.xClient?.client) {
      throw new Error("X service not available");
    }

    const clientBase = xService.xClient.client;
    if (!clientBase.profile) {
      throw new Error("X client not initialized - no profile");
    }
    const _client = clientBase.xClient;

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
      text = truncated.trim() || `${text.substring(0, 277)}...`;
    }

    let finalText = text;
    if (
      text.length < 50 ||
      text.toLowerCase().includes("post") ||
      text.toLowerCase().includes("post")
    ) {
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

    const result = await sendPost(clientBase, finalText);

    if (result) {
      const postId = result.id || result.data?.id || result.data?.data?.id || Date.now().toString();
      const postUrl = `https://x.com/${clientBase.profile.username}/status/${postId}`;

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

  examples: (spec.examples ?? []) as ActionExample[][],
};
