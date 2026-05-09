/**
 * Media analysis actions.
 *
 * Media generation is provided by the core GENERATE_MEDIA action and the
 * AgentMediaGenerationService registered by the eliza runtime plugin.
 */

import type {
  Action,
  ActionExample,
  HandlerOptions,
  IAgentRuntime,
} from "@elizaos/core";
import { isElizaCloudServiceSelectedInConfig } from "@elizaos/shared";
import { loadElizaConfig } from "../config/config.ts";
import {
  createVisionProvider,
  type MediaProviderFactoryOptions,
} from "../providers/media-provider.ts";

function getMediaProviderOptions(): MediaProviderFactoryOptions {
  const config = loadElizaConfig();
  const cloudMediaSelected = isElizaCloudServiceSelectedInConfig(
    config as Record<string, unknown>,
    "media",
  );
  return {
    elizaCloudBaseUrl: config.cloud?.baseUrl ?? "https://elizacloud.ai/api/v1",
    elizaCloudApiKey: config.cloud?.apiKey,
    cloudMediaDisabled: !cloudMediaSelected,
  };
}

export const analyzeImageAction: Action = {
  name: "ANALYZE_IMAGE",
  contexts: ["general", "media", "files"],
  roleGate: { minRole: "USER" },

  similes: [
    "DESCRIBE_IMAGE",
    "WHAT_IS_IN_IMAGE",
    "IDENTIFY_IMAGE",
    "READ_IMAGE",
    "UNDERSTAND_IMAGE",
    "VISION",
    "OCR",
    "IMAGE_TO_TEXT",
  ],

  description:
    "Analyze an image using AI vision to describe its contents, identify objects, " +
    "read text, or answer questions about the image.",
  descriptionCompressed:
    "analyze image use AI vision describe content, identify object, read text, answer question image",

  validate: async (_runtime: IAgentRuntime) => {
    try {
      const config = loadElizaConfig();
      createVisionProvider(config.media?.vision, getMediaProviderOptions());
      return true;
    } catch {
      return false;
    }
  },

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | {
          imageUrl?: string;
          imageBase64?: string;
          prompt?: string;
          maxTokens?: number;
        }
      | undefined;

    const hasImage = params?.imageUrl || params?.imageBase64;
    if (!hasImage) {
      return {
        text: "I need an image to analyze. Please provide an image URL or upload an image.",
        success: false,
      };
    }

    const config = loadElizaConfig();
    const provider = createVisionProvider(
      config.media?.vision,
      getMediaProviderOptions(),
    );

    const result = await provider.analyze({
      imageUrl: params?.imageUrl,
      imageBase64: params?.imageBase64,
      prompt: params?.prompt ?? "Describe this image in detail.",
      maxTokens: params?.maxTokens,
    });

    if (!result.success || !result.data) {
      return {
        text: `I couldn't analyze the image: ${result.error ?? "Unknown error"}`,
        success: false,
      };
    }

    return {
      text: result.data.description,
      success: true,
      data: {
        description: result.data.description,
        labels: result.data.labels,
        confidence: result.data.confidence,
      },
    };
  },

  parameters: [
    {
      name: "imageUrl",
      description: "URL of the image to analyze",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "imageBase64",
      description: "Base64-encoded image data",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "prompt",
      description:
        "Specific question or instruction for the analysis (default: describe the image)",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "maxTokens",
      description: "Maximum tokens for the response",
      required: false,
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "What's in this screenshot I just sent?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "It's a dashboard showing weekly sales metrics with three line charts.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Read the receipt in the photo and tell me the total.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "The receipt is from Blue Bottle Coffee, total $14.75.",
        },
      },
    ],
  ] as ActionExample[][],
};

export const mediaActions = [analyzeImageAction];
