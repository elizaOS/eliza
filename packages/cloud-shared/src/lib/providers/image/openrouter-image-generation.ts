import { getAiProviderConfigurationError } from "../language-model";
import type { GeneratedImage, ImageGenRequest, ImageProvider } from "./types";

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function dataUrlToImage(dataUrl: string): { bytes: Uint8Array; mimeType: string } {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) {
    throw new Error("Image provider returned an invalid image data URL");
  }
  return { mimeType: match[1], bytes: base64ToBytes(match[2]) };
}

function buildOpenRouterMessages(request: ImageGenRequest) {
  if (!request.sourceImage) {
    return [{ role: "user", content: request.prompt }];
  }

  return [
    {
      role: "user",
      content: [
        { type: "text", text: request.prompt },
        { type: "image_url", image_url: { url: request.sourceImage } },
      ],
    },
  ];
}

function extractOpenRouterImage(payload: Record<string, unknown>): {
  dataUrl: string;
  text: string;
} {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const message = (choices[0] as { message?: Record<string, unknown> } | undefined)?.message;
  const images = Array.isArray(message?.images) ? message.images : [];
  const firstImage = images[0] as { image_url?: string | { url?: string } } | undefined;
  const imageUrl = firstImage?.image_url;
  const dataUrl = typeof imageUrl === "string" ? imageUrl : imageUrl?.url;
  if (!dataUrl) {
    throw new Error("Image provider returned no image");
  }

  const content = message?.content;
  const text = typeof content === "string" ? content : "";
  return { dataUrl, text };
}

export async function generateOpenRouterImage(request: ImageGenRequest): Promise<GeneratedImage> {
  const apiKey = request.apiKeys.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(getAiProviderConfigurationError());
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "http-referer": "https://elizacloud.ai",
      "x-title": "Eliza Cloud Image Generation",
    },
    body: JSON.stringify({
      model: request.model,
      messages: buildOpenRouterMessages(request),
      modalities: ["image", "text"],
      ...(request.aspectRatio || request.size
        ? {
            image_config: {
              ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
              ...(request.size ? { size: request.size } : {}),
            },
          }
        : {}),
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error as { message?: string; code?: string } | undefined;
    const message = error?.message ?? `OpenRouter image generation failed: ${response.status}`;
    const code = error?.code ? ` (${error.code})` : "";
    throw new Error(`${message}${code}`);
  }

  const { dataUrl, text } = extractOpenRouterImage(payload);
  const { bytes, mimeType } = dataUrlToImage(dataUrl);
  return { dataUrl, bytes, mimeType, text };
}

export const openRouterImageProvider: ImageProvider = {
  billingSource: "openrouter",
  generate: generateOpenRouterImage,
  async healthCheck() {
    return true;
  },
};
