import { v4 } from "uuid";
import { logger } from "../../logger.ts";
import { imageGenerationTemplate } from "../../prompts.ts";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "../../types/index.ts";
import { ContentType, ModelType } from "../../types/index.ts";
import { composePromptFromState, parseKeyValueXml } from "../../utils.ts";

export const generateImageAction = {
  name: "GENERATE_IMAGE",
  similes: ["DRAW", "CREATE_IMAGE", "RENDER_IMAGE", "VISUALIZE"],
  description:
    "Generates an image based on a generated prompt reflecting the current conversation. Use GENERATE_IMAGE when the agent needs to visualize, illustrate, or demonstrate something visually for the user.",
  validate: async (_runtime: IAgentRuntime) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
    responses?: Memory[],
  ): Promise<ActionResult> => {
    const allProviders =
      responses?.flatMap((res) => res.content?.providers || []) || [];

    state = await runtime.composeState(message, [
      ...(allProviders ?? []),
      "RECENT_MESSAGES",
    ]);

    const prompt = composePromptFromState({
      state,
      template:
        runtime.character.templates?.imageGenerationTemplate ||
        imageGenerationTemplate,
    });

    const promptResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
    });

    const parsedXml = parseKeyValueXml(promptResponse);
    const promptValue = parsedXml?.prompt;

    const imagePrompt: string =
      typeof promptValue === "string"
        ? promptValue
        : "Unable to generate descriptive prompt for image";

    const imageResponse = await runtime.useModel(ModelType.IMAGE, {
      prompt: imagePrompt,
    });

    if (
      !imageResponse ||
      imageResponse.length === 0 ||
      !imageResponse[0]?.url
    ) {
      logger.error(
        {
          src: "plugin:bootstrap:action:image_generation",
          agentId: runtime.agentId,
          imagePrompt,
        },
        "Image generation failed - no valid response received",
      );
      return {
        text: "Image generation failed",
        values: {
          success: false,
          error: "IMAGE_GENERATION_FAILED",
          prompt: imagePrompt,
        },
        data: {
          actionName: "GENERATE_IMAGE",
          prompt: imagePrompt,
          rawResponse: imageResponse,
        },
        success: false,
      };
    }

    const imageUrl = imageResponse[0].url;

    logger.info(
      {
        src: "plugin:bootstrap:action:image_generation",
        agentId: runtime.agentId,
        imageUrl,
      },
      "Received image URL",
    );

    const getFileExtension = (url: string): string => {
      const urlPath = new URL(url).pathname;
      const urlPathSplit = urlPath.split(".");
      const extension =
        urlPathSplit.length > 0 &&
        urlPathSplit[urlPathSplit.length - 1] &&
        urlPathSplit[urlPathSplit.length - 1].toLowerCase();
      if (
        extension &&
        ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(extension)
      ) {
        return extension;
      }
      return "png";
    };

    const extension = getFileExtension(imageUrl);
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const fileName = `Generated_Image_${timestamp}.${extension}`;
    const attachmentId = v4();

    const responseContent = {
      attachments: [
        {
          id: attachmentId,
          url: imageUrl,
          title: fileName,
          contentType: ContentType.IMAGE,
        },
      ],
      thought: `Generated an image based on: "${imagePrompt}"`,
      actions: ["GENERATE_IMAGE"],
      text: imagePrompt,
    };

    if (callback) {
      await callback(responseContent);
    }

    return {
      text: "Generated image",
      values: {
        success: true,
        imageGenerated: true,
        imageUrl,
        prompt: imagePrompt,
      },
      data: {
        actionName: "GENERATE_IMAGE",
        imageUrl,
        prompt: imagePrompt,
      },
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
          text: "Sure, I'll create a futuristic city image for you. One moment...",
          actions: ["GENERATE_IMAGE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "What does a neural network look like visually?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I’ll create a visualization of a neural network for you, one sec...",
          actions: ["GENERATE_IMAGE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Can you visualize the feeling of calmness for me?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Creating an image to capture calmness for you, please wait a moment...",
          actions: ["GENERATE_IMAGE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "What does excitement look like as an image?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Let me generate an image that represents excitement for you, give me a second...",
          actions: ["GENERATE_IMAGE"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
