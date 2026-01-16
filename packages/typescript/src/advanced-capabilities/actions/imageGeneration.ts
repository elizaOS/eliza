import { v4 } from "uuid";
import { requireActionSpec } from "../../generated/spec-helpers.ts";
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

// Get text content from centralized specs
const spec = requireActionSpec("GENERATE_IMAGE");
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

const getFileExtension = (url: string): string => {
  const urlPath = new URL(url).pathname;
  const lastDot = urlPath.lastIndexOf(".");
  if (lastDot === -1 || lastDot === urlPath.length - 1) {
    return "png";
  }
  const extension = urlPath.slice(lastDot + 1).toLowerCase();
  return IMAGE_EXTENSIONS.has(extension) ? extension : "png";
};

export const generateImageAction = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
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
    const allProviders: string[] = [];
    if (responses) {
      for (const res of responses) {
        const providers = res.content?.providers;
        if (providers && providers.length > 0) {
          allProviders.push(...providers);
        }
      }
    }

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
      stopSequences: [],
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
          rawResponse: imageResponse.map((image) => ({ url: image.url })),
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
  examples: (spec.examples ?? []) as ActionExample[][],
} as Action;
