/** GENERATE_IMAGE Action - Generates an image based on a prompt. */
import {
  type Action,
  type ActionExample,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  ContentType,
  parseKeyValueXml,
  type ActionResult,
  logger,
} from "@elizaos/core";
import { v4 } from "uuid";
import type { ActionWithParams } from "../types";

const IMAGE_GENERATION_TEMPLATE = `# Task: Generate an image prompt based on the user's request.
# Instructions:
Based on the user's message in the conversation, write a clear, concise, and visually descriptive prompt for image generation. Focus only on what the user wants to see, extract the key visual elements from the request, and formulate a detailed prompt suitable for image generation.

{{#if providedPrompt}}
# User provided a direct prompt:
{{providedPrompt}}

Use this prompt directly or enhance it slightly for better image generation results.
{{else}}
# Conversation context:
{{conversationLog}}

{{receivedMessageHeader}}
{{/if}}

Your response should be formatted in XML like this:
<response>
  <prompt>Your image generation prompt here</prompt>
</response>

Your response should include the valid XML block and nothing else.`;

const VALID_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

function getFileExtension(url: string): string {
  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
    return ext && VALID_IMAGE_EXTENSIONS.has(ext) ? ext : "png";
  } catch {
    return "png";
  }
}

function extractParams(message: Memory, state?: State): Record<string, unknown> {
  const content = message.content as Record<string, unknown>;
  return (content.actionParams || content.actionInput || state?.data?.actionParams || state?.data?.generateimage || {}) as Record<string, unknown>;
}

export const generateImageAction: ActionWithParams = {
  name: "GENERATE_IMAGE",
  similes: ["DRAW", "CREATE_IMAGE", "RENDER_IMAGE", "VISUALIZE"],
  description: "Generates an image based on a prompt. Use when the user wants to visualize, illustrate, or see something visually.",

  parameters: {
    prompt: {
      type: "string",
      description: "Optional direct prompt for image generation. If not provided, will extract from conversation.",
      required: false,
    },
  },

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Check runtime has required model capability
    if (!runtime.useModel) {
      logger.warn("[GENERATE_IMAGE] Runtime missing useModel capability");
      return false;
    }

    // Check message has content (needed for prompt extraction)
    if (!message.content) {
      logger.warn("[GENERATE_IMAGE] Message has no content");
      return false;
    }

    // Image generation requires either text content or explicit prompt parameter
    const content = message.content as Record<string, unknown>;
    const actionParams = content.actionParams as Record<string, unknown> | undefined;
    const actionInput = content.actionInput as Record<string, unknown> | undefined;
    const hasText = typeof message.content.text === "string" && message.content.text.trim().length > 0;
    const hasPromptParam = actionParams?.prompt || actionInput?.prompt;
    
    if (!hasText && !hasPromptParam) {
      logger.debug("[GENERATE_IMAGE] No text content or prompt parameter available");
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
    responses?: Memory[]
  ): Promise<ActionResult> => {
    const params = extractParams(message, state);
    const providedPrompt = params.prompt as string | undefined;

    logger.info(
      `[GENERATE_IMAGE] Starting image generation${providedPrompt ? ` with prompt: "${providedPrompt.substring(0, 50)}..."` : " from conversation"}`
    );

    const allProviders = responses?.flatMap((res) => res.content?.providers ?? []) ?? [];

    if (!state) {
      state = await runtime.composeState(message, [...allProviders, "RECENT_MESSAGES"]);
    } else if (allProviders.length > 0) {
      state.values = { ...state.values, additionalProviders: allProviders };
    }

    if (providedPrompt) {
      state.values = { ...state.values, providedPrompt };
    }

    const prompt = composePromptFromState({
      state,
      template: runtime.character.templates?.imageGenerationTemplate || IMAGE_GENERATION_TEMPLATE,
    });

    const promptResponse = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    const parsedXml = parseKeyValueXml(promptResponse);
    const imagePrompt: string = typeof parsedXml?.prompt === "string"
      ? parsedXml.prompt
      : providedPrompt || "Unable to generate descriptive prompt for image";

    logger.info(`[GENERATE_IMAGE] Using prompt: "${imagePrompt}"`);

    const imageResponse = await runtime.useModel(ModelType.IMAGE, { prompt: imagePrompt });

    if (!imageResponse?.length || !imageResponse[0]?.url) {
      logger.error(`[GENERATE_IMAGE] Image generation failed - no valid response received`);
      return {
        text: `Image generation failed for prompt: "${imagePrompt}"`,
        values: { success: false, error: "IMAGE_GENERATION_FAILED", prompt: imagePrompt },
        data: {
          actionName: "GENERATE_IMAGE",
          error: "Image model returned no results. Try a different image generation model.",
          prompt: imagePrompt,
        },
        success: false,
      };
    }

    const imageUrl = imageResponse[0].url;
    const extension = getFileExtension(imageUrl);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fileName = `Generated_Image_${timestamp}.${extension}`;
    const attachmentId = v4();

    const attachment = { id: attachmentId, url: imageUrl, title: fileName, contentType: ContentType.IMAGE };

    if (callback) {
      await callback({
        attachments: [attachment],
        thought: `Generated an image based on: "${imagePrompt}"`,
        actions: ["GENERATE_IMAGE"],
        text: imagePrompt,
      });
    }

    logger.info(`[GENERATE_IMAGE] Successfully generated image: ${imageUrl}`);

    return {
      text: `Generated image: "${imagePrompt}"`,
      values: { success: true, imageGenerated: true, imageUrl, prompt: imagePrompt },
      data: { actionName: "GENERATE_IMAGE", imageUrl, prompt: imagePrompt, attachments: [attachment] },
      success: true,
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Can you show me what a futuristic city looks like?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Sure, I'll create a futuristic city image for you.",
          actions: ["GENERATE_IMAGE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Generate an image of a cat wearing a space helmet",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Creating that image now...",
          actions: ["GENERATE_IMAGE"],
        },
      },
    ],
  ] as ActionExample[][],
};
