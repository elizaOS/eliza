/**
 * Cloud-local GENERATE_IMAGE mirror.
 *
 * The canonical local-runtime GENERATE_IMAGE semantics live in
 * @elizaos/core advanced capabilities. Cloud bootstrap runs in cloud assistant
 * deployments instead of the local agent/core action stack, so this keeps the
 * public cloud planner action name while preserving callback/result parity.
 */
import {
  type ActionExample,
  type ActionResult,
  ContentType,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import { v4 } from "uuid";
import { type ActionWithParams, defineActionParameters } from "../types";
import { normalizeCloudActionArgs } from "../utils/native-planner-guards";

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

Respond using JSON only. No markdown, no prose, no XML.
{
  "prompt": "Your image generation prompt here"
}`;

const VALID_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const IMAGE_CONTEXTS = ["general", "media"];
const IMAGE_KEYWORDS = [
  "image",
  "picture",
  "photo",
  "draw",
  "illustrate",
  "visualize",
  "render",
  "generate",
  "create",
  "imagen",
  "foto",
  "dibujar",
  "ilustrar",
  "visualizar",
  "generar",
  "crear",
  "image",
  "photo",
  "dessiner",
  "illustrer",
  "visualiser",
  "generer",
  "creer",
  "bild",
  "foto",
  "zeichnen",
  "visualisieren",
  "generieren",
  "erstellen",
  "immagine",
  "foto",
  "disegna",
  "visualizza",
  "genera",
  "crea",
  "imagem",
  "foto",
  "desenhar",
  "visualizar",
  "gerar",
  "criar",
  "图片",
  "图像",
  "照片",
  "画",
  "生成",
  "画像",
  "写真",
  "描いて",
  "生成",
];

function hasSelectedContext(state: State | undefined): boolean {
  const selected = [
    state?.data?.selectedContexts,
    state?.data?.activeContexts,
    state?.data?.contexts,
    state?.values?.selectedContexts,
    state?.values?.activeContexts,
    state?.values?.contexts,
  ].flatMap((value) => (Array.isArray(value) ? value : typeof value === "string" ? [value] : []));
  return selected.some((context) => IMAGE_CONTEXTS.includes(String(context).toLowerCase()));
}

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
  return normalizeCloudActionArgs("GENERATE_IMAGE", {
    params: content.params || state?.data?.params,
    actionParams: content.actionParams || state?.data?.actionParams || state?.data?.generateimage,
    actionInput: content.actionInput,
  });
}

export const generateImageAction: ActionWithParams = {
  name: "GENERATE_IMAGE",
  contexts: IMAGE_CONTEXTS,
  contextGate: { anyOf: IMAGE_CONTEXTS },
  roleGate: { minRole: "USER" },
  similes: ["DRAW", "CREATE_IMAGE", "RENDER_IMAGE", "VISUALIZE"],
  description:
    "Generates an image based on a prompt. Use when the user wants to visualize, illustrate, or see something visually.",

  parameters: defineActionParameters({
    prompt: {
      type: "string",
      description:
        "Optional direct prompt for image generation. If not provided, will extract from conversation.",
      required: false,
    },
  }),

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
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
    const actionParams = extractParams(message);
    const hasText =
      typeof message.content.text === "string" && message.content.text.trim().length > 0;
    const hasPromptParam = actionParams.prompt;
    const conversationText = [
      message.content.text,
      state?.values?.conversationLog,
      state?.values?.recentMessages,
    ]
      .filter((value): value is string => typeof value === "string")
      .join("\n")
      .toLowerCase();
    const hasImageKeyword = IMAGE_KEYWORDS.some((keyword) =>
      conversationText.includes(keyword.toLowerCase()),
    );

    if (!hasText && !hasPromptParam) {
      logger.debug("[GENERATE_IMAGE] No text content or prompt parameter available");
      return false;
    }

    return hasSelectedContext(state) || !!hasPromptParam || hasImageKeyword;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
    responses?: Memory[],
  ): Promise<ActionResult> => {
    const params = extractParams(message, state);
    const providedPrompt = params.prompt as string | undefined;

    logger.info(
      `[GENERATE_IMAGE] Starting image generation${providedPrompt ? ` with prompt: "${providedPrompt.substring(0, 50)}..."` : " from conversation"}`,
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

    let promptResponse: string;
    try {
      promptResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, "[GENERATE_IMAGE] Prompt model call failed");
      return {
        success: false,
        text: "Image generation failed while preparing the prompt.",
        error: errorMessage,
        data: { actionName: "GENERATE_IMAGE", prompt: providedPrompt },
      };
    }
    const parsedPrompt = parseJSONObjectFromText(promptResponse);
    const imagePrompt: string =
      typeof parsedPrompt?.prompt === "string"
        ? parsedPrompt.prompt
        : providedPrompt || "Unable to generate descriptive prompt for image";

    logger.info(`[GENERATE_IMAGE] Using prompt: "${imagePrompt}"`);

    let imageResponse;
    try {
      imageResponse = await runtime.useModel(ModelType.IMAGE, {
        prompt: imagePrompt,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, "[GENERATE_IMAGE] Image model call failed");
      return {
        text: `Image generation failed for prompt: "${imagePrompt}"`,
        values: {
          success: false,
          error: "IMAGE_GENERATION_FAILED",
          prompt: imagePrompt,
        },
        data: {
          actionName: "GENERATE_IMAGE",
          error: errorMessage,
          prompt: imagePrompt,
        },
        error: errorMessage,
        success: false,
      };
    }

    if (!imageResponse?.length || !imageResponse[0]?.url) {
      logger.error(`[GENERATE_IMAGE] Image generation failed - no valid response received`);
      return {
        text: `Image generation failed for prompt: "${imagePrompt}"`,
        values: {
          success: false,
          error: "IMAGE_GENERATION_FAILED",
          prompt: imagePrompt,
        },
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

    const attachment = {
      id: attachmentId,
      url: imageUrl,
      title: fileName,
      contentType: ContentType.IMAGE,
    };

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
        attachments: [attachment],
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
