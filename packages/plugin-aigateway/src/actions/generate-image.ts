import {
  Action,
  IAgentRuntime,
  Memory,
  State,
  ModelType,
  HandlerCallback,
} from "@elizaos/core";

export const generateImageAction: Action = {
  name: "GENERATE_IMAGE",
  description: "Generate images using AI Gateway image models",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const content = message.content;
    const text = content.text?.toLowerCase() || "";

    // Check for explicit prompt or image-related keywords
    return (
      !!content.prompt ||
      text.includes("image") ||
      text.includes("picture") ||
      text.includes("photo") ||
      text.includes("draw") ||
      (text.includes("generate") &&
        (text.includes("visual") || text.includes("art")))
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: any,
    callback?: HandlerCallback,
  ): Promise<void> => {
    const content = message.content;
    const prompt = content.prompt || content.text;
    const size = content.size || "1024x1024";
    const n = content.n || 1;

    if (!prompt) {
      if (callback) {
        await callback({
          text: "Please provide a prompt for image generation.",
          success: false,
        });
      }
      return;
    }

    try {
      const response = await runtime.useModel(ModelType.IMAGE, {
        prompt,
        n,
        size,
      });

      const images = Array.isArray(response) ? response : [response];
      const imageUrls = images
        .map((img: any) => img.url || img)
        .filter(Boolean);

      if (callback) {
        await callback({
          text: `Generated ${imageUrls.length} image(s)`,
          images: imageUrls,
          success: true,
        });
      }

      return;
    } catch (error) {
      // Error occurred while generating image

      if (callback) {
        await callback({
          text: "Sorry, I encountered an error while generating the image.",
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return;
    }
  },

  examples: [
    [
      {
        name: "user",
        content: {
          text: "Generate an image of a sunset over mountains",
        },
      },
      {
        name: "assistant",
        content: {
          text: "Generated 1 image(s)",
          images: ["https://example.com/sunset.png"],
          action: "GENERATE_IMAGE",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Create a picture of a futuristic city",
          size: "1792x1024",
        },
      },
      {
        name: "assistant",
        content: {
          text: "Generated 1 image(s)",
          images: ["https://example.com/city.png"],
          action: "GENERATE_IMAGE",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          prompt: "Abstract art with vibrant colors",
          n: 4,
          size: "512x512",
        },
      },
      {
        name: "assistant",
        content: {
          text: "Generated 4 image(s)",
          action: "GENERATE_IMAGE",
        },
      },
    ],
  ],

  similes: [
    "create_image",
    "make_picture",
    "draw",
    "ai_image",
    "dall-e",
    "image_generation",
  ],
};
