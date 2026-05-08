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
import { loadElizaConfig } from "../config/config.js";
import {
  createVisionProvider,
  type MediaProviderFactoryOptions,
} from "../providers/media-provider.js";
import {
  hasSelectedContextOrSignalSync,
  messageText,
} from "./context-signal.js";

const MEDIA_ACTION_CONTEXTS = ["general", "media", "files"] as const;
const ANALYZE_IMAGE_STRONG_TERMS = [
  "analyze image",
  "describe image",
  "what is in this image",
  "what's in this image",
  "read image",
  "read screenshot",
  "read receipt",
  "ocr",
  "vision",
  "screenshot",
  "photo",
  "image",
  "分析图片",
  "描述图片",
  "识别图片",
  "截图",
  "이미지 분석",
  "사진 설명",
  "스크린샷",
  "analiza imagen",
  "describe imagen",
  "leer imagen",
  "captura de pantalla",
  "analise imagem",
  "descreva imagem",
  "ler imagem",
  "ảnh chụp màn hình",
  "anh chup man hinh",
  "phân tích ảnh",
  "phan tich anh",
  "ilarawan ang larawan",
  "basahin ang larawan",
  "screenshot",
];

function hasMediaActionSignal(
  message: Parameters<NonNullable<Action["validate"]>>[1],
  state: Parameters<NonNullable<Action["validate"]>>[2],
  strongTerms: readonly string[],
  weakTerms: readonly string[] = [],
): boolean {
  return hasSelectedContextOrSignalSync(
    message,
    state,
    MEDIA_ACTION_CONTEXTS,
    strongTerms,
    weakTerms,
    8,
  );
}

function messageHasImageAttachment(
  message: Parameters<NonNullable<Action["validate"]>>[1],
): boolean {
  const content = message.content as Record<string, unknown> | undefined;
  const attachments = content?.attachments;
  if (!Array.isArray(attachments)) return false;
  return attachments.some((attachment) => {
    if (!attachment || typeof attachment !== "object") return false;
    const record = attachment as Record<string, unknown>;
    return (
      record.type === "image" ||
      (typeof record.mimeType === "string" &&
        record.mimeType.toLowerCase().startsWith("image/"))
    );
  });
}

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

  validate: async (_runtime: IAgentRuntime, message, state) =>
    messageHasImageAttachment(message) ||
    hasMediaActionSignal(message, state, ANALYZE_IMAGE_STRONG_TERMS) ||
    /\b(image|photo|screenshot|receipt|ocr)\b/i.test(messageText(message)),

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
