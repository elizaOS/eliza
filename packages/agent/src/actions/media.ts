/**
 * Media Generation Actions
 *
 * Provides runtime actions for generating and analyzing media:
 * - GENERATE_IMAGE: Text-to-image generation
 * - GENERATE_VIDEO: Text-to-video generation
 * - GENERATE_AUDIO: Text-to-audio/music generation
 * - ANALYZE_IMAGE: Vision/image analysis
 *
 * Uses the media-provider abstraction with Eliza Cloud as default,
 * or user-configured providers (FAL, OpenAI, Google, Anthropic, etc.)
 *
 * @module actions/media
 */

import type { Action, HandlerOptions, IAgentRuntime } from "@elizaos/core";
import { isElizaCloudServiceSelectedInConfig } from "@elizaos/shared/contracts";
import { loadElizaConfig } from "../config/config.js";
import {
  createAudioProvider,
  createImageProvider,
  createVideoProvider,
  createVisionProvider,
  type MediaProviderFactoryOptions,
} from "../providers/media-provider.js";

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

// ============================================================================
// GENERATE_IMAGE Action
// ============================================================================

export const generateImageAction: Action = {
  name: "GENERATE_IMAGE",

  similes: [
    "CREATE_IMAGE",
    "MAKE_IMAGE",
    "DRAW",
    "PAINT",
    "ILLUSTRATE",
    "RENDER_IMAGE",
    "IMAGE_GEN",
    "TEXT_TO_IMAGE",
  ],

  description:
    "Generate an image from a text prompt using AI image generation. " +
    "Supports various styles, sizes, and quality settings.",

  validate: async (_runtime: IAgentRuntime) => true,

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | {
          prompt?: string;
          size?: string;
          quality?: "standard" | "hd";
          style?: "natural" | "vivid";
          negativePrompt?: string;
        }
      | undefined;

    const prompt = params?.prompt;
    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return {
        text: "I need a prompt to generate an image. Please describe what you'd like me to create.",
        success: false,
      };
    }

    const config = loadElizaConfig();
    const provider = createImageProvider(
      config.media?.image,
      getMediaProviderOptions(),
    );

    const result = await provider.generate({
      prompt: prompt.trim(),
      size: params?.size,
      quality: params?.quality,
      style: params?.style,
      negativePrompt: params?.negativePrompt,
    });

    if (!result.success || !result.data) {
      return {
        text: `I couldn't generate the image: ${result.error ?? "Unknown error"}`,
        success: false,
      };
    }

    const imageUrl = result.data.imageUrl ?? result.data.imageBase64;
    const revisedPrompt = result.data.revisedPrompt;

    return {
      text: revisedPrompt
        ? `Here's the generated image based on: "${revisedPrompt}"`
        : "Here's the generated image.",
      success: true,
      data: {
        imageUrl: result.data.imageUrl,
        imageBase64: result.data.imageBase64,
        revisedPrompt,
      },
      attachments: imageUrl
        ? [
            {
              type: "image",
              url: result.data.imageUrl,
              base64: result.data.imageBase64,
              mimeType: "image/png",
            },
          ]
        : undefined,
    };
  },

  parameters: [
    {
      name: "prompt",
      description: "The text description of the image to generate",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "size",
      description: "Image size (e.g., '1024x1024', '1792x1024')",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "quality",
      description: "Image quality ('standard' or 'hd')",
      required: false,
      schema: { type: "string" as const, enum: ["standard", "hd"] },
    },
    {
      name: "style",
      description: "Image style ('natural' or 'vivid')",
      required: false,
      schema: { type: "string" as const, enum: ["natural", "vivid"] },
    },
    {
      name: "negativePrompt",
      description: "Things to avoid in the generated image",
      required: false,
      schema: { type: "string" as const },
    },
  ],
};

// ============================================================================
// GENERATE_VIDEO Action
// ============================================================================

export const generateVideoAction: Action = {
  name: "GENERATE_VIDEO",

  similes: [
    "CREATE_VIDEO",
    "MAKE_VIDEO",
    "ANIMATE",
    "RENDER_VIDEO",
    "VIDEO_GEN",
    "TEXT_TO_VIDEO",
    "FILM",
  ],

  description:
    "Generate a video from a text prompt using AI video generation. " +
    "Can optionally use an input image for image-to-video generation.",

  validate: async (_runtime: IAgentRuntime) => true,

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | {
          prompt?: string;
          duration?: number;
          aspectRatio?: string;
          imageUrl?: string;
        }
      | undefined;

    const prompt = params?.prompt;
    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return {
        text: "I need a prompt to generate a video. Please describe what you'd like me to create.",
        success: false,
      };
    }

    const config = loadElizaConfig();
    const provider = createVideoProvider(
      config.media?.video,
      getMediaProviderOptions(),
    );

    const result = await provider.generate({
      prompt: prompt.trim(),
      duration: params?.duration,
      aspectRatio: params?.aspectRatio,
      imageUrl: params?.imageUrl,
    });

    if (!result.success || !result.data) {
      return {
        text: `I couldn't generate the video: ${result.error ?? "Unknown error"}`,
        success: false,
      };
    }

    return {
      text: "Here's the generated video.",
      success: true,
      data: {
        videoUrl: result.data.videoUrl,
        thumbnailUrl: result.data.thumbnailUrl,
        duration: result.data.duration,
      },
      attachments: result.data.videoUrl
        ? [
            {
              type: "video",
              url: result.data.videoUrl,
              mimeType: "video/mp4",
            },
          ]
        : undefined,
    };
  },

  parameters: [
    {
      name: "prompt",
      description: "The text description of the video to generate",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "duration",
      description: "Video duration in seconds",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "aspectRatio",
      description: "Video aspect ratio (e.g., '16:9', '9:16', '1:1')",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "imageUrl",
      description: "URL of an image to use as starting frame (image-to-video)",
      required: false,
      schema: { type: "string" as const },
    },
  ],
};

// ============================================================================
// GENERATE_AUDIO Action
// ============================================================================

export const generateAudioAction: Action = {
  name: "GENERATE_AUDIO",

  similes: [
    "CREATE_AUDIO",
    "MAKE_MUSIC",
    "COMPOSE",
    "GENERATE_MUSIC",
    "CREATE_SONG",
    "MAKE_SOUND",
    "AUDIO_GEN",
    "TEXT_TO_MUSIC",
  ],

  description:
    "Generate audio or music from a text prompt using AI audio generation. " +
    "Can create songs, sound effects, or instrumental music.",

  validate: async (_runtime: IAgentRuntime) => true,

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | {
          prompt?: string;
          duration?: number;
          instrumental?: boolean;
          genre?: string;
        }
      | undefined;

    const prompt = params?.prompt;
    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return {
        text: "I need a prompt to generate audio. Please describe the music or sound you'd like me to create.",
        success: false,
      };
    }

    const config = loadElizaConfig();
    const provider = createAudioProvider(
      config.media?.audio,
      getMediaProviderOptions(),
    );

    const result = await provider.generate({
      prompt: prompt.trim(),
      duration: params?.duration,
      instrumental: params?.instrumental,
      genre: params?.genre,
    });

    if (!result.success || !result.data) {
      return {
        text: `I couldn't generate the audio: ${result.error ?? "Unknown error"}`,
        success: false,
      };
    }

    const title = result.data.title ?? "Generated Audio";

    return {
      text: `Here's the generated audio: "${title}"`,
      success: true,
      data: {
        audioUrl: result.data.audioUrl,
        title: result.data.title,
        duration: result.data.duration,
      },
      attachments: result.data.audioUrl
        ? [
            {
              type: "audio",
              url: result.data.audioUrl,
              mimeType: "audio/mpeg",
              title,
            },
          ]
        : undefined,
    };
  },

  parameters: [
    {
      name: "prompt",
      description:
        "The text description of the audio to generate (song lyrics, mood, style, etc.)",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "duration",
      description: "Audio duration in seconds",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "instrumental",
      description: "Whether to generate instrumental music without vocals",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "genre",
      description:
        "Music genre (e.g., 'pop', 'rock', 'classical', 'synthwave')",
      required: false,
      schema: { type: "string" as const },
    },
  ],
};

// ============================================================================
// ANALYZE_IMAGE Action
// ============================================================================

export const analyzeImageAction: Action = {
  name: "ANALYZE_IMAGE",

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

  validate: async (_runtime: IAgentRuntime) => true,

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
};

export const mediaActions = [
  generateImageAction,
  generateVideoAction,
  generateAudioAction,
  analyzeImageAction,
];
