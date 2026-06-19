import {
  type ActionExample,
  type ActionResult,
  ContentType,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type MediaGenerationMediaType,
  type Memory,
  ServiceType,
  type State,
} from "@elizaos/core";
import { v4 } from "uuid";
import type { CloudMediaGenerationService } from "../services/cloud-media-generation-service";
import { type ActionWithParams, defineActionParameters } from "../types";
import { normalizeCloudActionArgs } from "../utils/native-planner-guards";

const ACTION_NAME = "GENERATE_MEDIA";
const MEDIA_CONTEXTS = ["general", "media", "files"];
const VALID_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
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
  "dessiner",
  "illustrer",
  "visualiser",
  "generer",
  "creer",
  "bild",
  "zeichnen",
  "visualisieren",
  "generieren",
  "erstellen",
  "immagine",
  "disegna",
  "visualizza",
  "genera",
  "crea",
  "imagem",
  "desenhar",
  "gerar",
  "criar",
];

function getFileExtension(url: string): string {
  if (url.startsWith("data:image/")) {
    const mimeExtension = url.slice("data:image/".length).split(/[;,]/)[0]?.toLowerCase();
    return mimeExtension === "jpeg" ? "jpg" : mimeExtension || "png";
  }

  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
    return ext && VALID_IMAGE_EXTENSIONS.has(ext) ? ext : "png";
  } catch {
    return "png";
  }
}

function hasSelectedMediaContext(state: State | undefined): boolean {
  const selected = [
    state?.data?.selectedContexts,
    state?.data?.activeContexts,
    state?.data?.contexts,
    state?.values?.selectedContexts,
    state?.values?.activeContexts,
    state?.values?.contexts,
  ].flatMap((value) => (Array.isArray(value) ? value : typeof value === "string" ? [value] : []));

  return selected.some((context) => {
    const normalized = String(context).toLowerCase();
    return normalized === "media" || normalized === "files";
  });
}

function extractParams(message: Memory, state?: State): Record<string, unknown> {
  const content = message.content as Record<string, unknown>;
  return normalizeCloudActionArgs(ACTION_NAME, {
    params: content.params || state?.data?.params,
    actionParams: content.actionParams || state?.data?.actionParams || state?.data?.generatemedia,
    actionInput: content.actionInput,
  });
}

function normalizeMediaType(value: unknown): MediaGenerationMediaType {
  const normalized = String(value ?? "image")
    .trim()
    .toLowerCase();
  if (normalized === "audio" || normalized === "video") {
    return normalized;
  }
  return "image";
}

function readPrompt(message: Memory, params: Record<string, unknown>): string | undefined {
  const prompt = params.prompt ?? (message.content as Record<string, unknown>).prompt;
  if (typeof prompt === "string" && prompt.trim()) {
    return prompt.trim();
  }

  const text = message.content.text;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

function hasImageKeyword(message: Memory, state?: State): boolean {
  const text = [
    message.content.text,
    state?.values?.conversationLog,
    state?.values?.recentMessages,
    state?.data?.conversationLog,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();

  return IMAGE_KEYWORDS.some((keyword) => text.includes(keyword.toLowerCase()));
}

function getMediaService(runtime: IAgentRuntime): CloudMediaGenerationService | null {
  return runtime.getService(ServiceType.MEDIA_GENERATION) as CloudMediaGenerationService | null;
}

export const generateMediaAction: ActionWithParams = {
  name: ACTION_NAME,
  contexts: MEDIA_CONTEXTS,
  contextGate: { anyOf: MEDIA_CONTEXTS },
  roleGate: { minRole: "USER" },
  similes: ["CREATE_MEDIA", "CREATE_IMAGE", "DRAW", "RENDER_IMAGE", "VISUALIZE"],
  description:
    "Generates media from a prompt through the cloud-safe media generation service. Use for explicit image generation requests.",

  parameters: defineActionParameters({
    prompt: {
      type: "string",
      description: "Detailed prompt for the media to generate.",
      required: true,
    },
    mediaType: {
      type: "string",
      description: "Media type to generate. Cloud currently supports image.",
      required: false,
      enum: ["image"],
      default: "image",
    },
    size: {
      type: "string",
      description: "Optional image size supported by the configured image model.",
      required: false,
    },
  }),

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const params = extractParams(message, state);
    const mediaType = normalizeMediaType(params.mediaType ?? params.type);
    const prompt = readPrompt(message, params);

    if (mediaType !== "image") {
      return false;
    }

    if (!getMediaService(runtime)) {
      logger.warn("[GENERATE_MEDIA] Runtime missing media generation service");
      return false;
    }

    if (!prompt) {
      return false;
    }

    return (
      hasSelectedMediaContext(state) ||
      Object.keys(params).length > 0 ||
      hasImageKeyword(message, state)
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = extractParams(message, state);
    const mediaType = normalizeMediaType(params.mediaType ?? params.type);
    const prompt = readPrompt(message, params);
    const size =
      typeof params.size === "string" && params.size.trim() ? params.size.trim() : undefined;

    if (mediaType !== "image") {
      return {
        text: "Cloud media generation currently supports image output only.",
        values: { success: false, error: "UNSUPPORTED_MEDIA_TYPE", mediaType },
        data: { actionName: ACTION_NAME, mediaType },
        success: false,
      };
    }

    if (!prompt) {
      return {
        text: "Media generation prompt is required.",
        values: { success: false, error: "MISSING_PROMPT" },
        data: { actionName: ACTION_NAME, error: "Missing prompt" },
        success: false,
      };
    }

    const service = getMediaService(runtime);
    if (!service) {
      return {
        text: "Media generation service is not available.",
        values: { success: false, error: "MEDIA_GENERATION_SERVICE_UNAVAILABLE" },
        data: { actionName: ACTION_NAME, error: "Media generation service unavailable" },
        success: false,
      };
    }

    logger.info(
      `[GENERATE_MEDIA] Starting ${mediaType} generation with prompt: "${prompt.substring(0, 80)}"`,
    );

    try {
      const media = await service.generateMedia({
        mediaType,
        prompt,
        ...(size ? { size } : {}),
      });
      const mediaUrl = media.url ?? media.imageUrl;

      if (!mediaUrl) {
        return {
          text: "Media generation failed.",
          values: { success: false, error: "MEDIA_GENERATION_FAILED", prompt, mediaType },
          data: { actionName: ACTION_NAME, prompt, mediaType },
          success: false,
        };
      }

      const extension = getFileExtension(mediaUrl);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const fileName = `Generated_Media_${timestamp}.${extension}`;
      const attachment = {
        id: v4(),
        url: mediaUrl,
        title: fileName,
        contentType: ContentType.IMAGE,
      };

      if (callback) {
        await callback({
          attachments: [attachment],
          thought: `Generated media based on: "${prompt}"`,
          actions: [ACTION_NAME],
          text: media.revisedPrompt ?? prompt,
        });
      }

      return {
        text: "Generated media",
        values: {
          success: true,
          mediaGenerated: true,
          mediaType,
          mediaUrl,
          prompt,
        },
        data: {
          actionName: ACTION_NAME,
          mediaType,
          mediaUrl,
          imageUrl: media.imageUrl ?? mediaUrl,
          prompt,
          attachments: [attachment],
        },
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, "[GENERATE_MEDIA] Media generation failed");
      return {
        text: `Media generation failed for prompt: "${prompt}"`,
        values: {
          success: false,
          error: "MEDIA_GENERATION_FAILED",
          mediaType,
          prompt,
        },
        data: {
          actionName: ACTION_NAME,
          error: errorMessage,
          mediaType,
          prompt,
        },
        error: errorMessage,
        success: false,
      };
    }
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
          actions: [ACTION_NAME],
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
          actions: [ACTION_NAME],
        },
      },
    ],
  ] as ActionExample[][],
};
