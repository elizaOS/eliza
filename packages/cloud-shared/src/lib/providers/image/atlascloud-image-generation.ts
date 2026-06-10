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

function buildAtlasMessages(request: ImageGenRequest) {
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

function extractAtlasImage(payload: Record<string, unknown>): {
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

function atlasBaseUrl(request: ImageGenRequest): string {
  const baseUrl = (request.apiKeys.ATLASCLOUD_BASE_URL || "https://api.atlascloud.ai/v1").replace(
    /\/+$/,
    "",
  );
  return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

export async function generateAtlasCloudImage(request: ImageGenRequest): Promise<GeneratedImage> {
  const apiKey = request.apiKeys.ATLASCLOUD_API_KEY;
  if (!apiKey) {
    throw new Error(getAiProviderConfigurationError());
  }

  const response = await fetch(`${atlasBaseUrl(request)}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    // Payload mirrors the proven BitRouter image-via-chat shape: an
    // OpenAI-compatible chat completion with modalities including "image".
    // Atlas exposes the same OpenAI-compatible surface, so the same request
    // body produces an image in choices[0].message.images[0].image_url.
    body: JSON.stringify({
      model: request.model,
      messages: buildAtlasMessages(request),
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
    const message = error?.message ?? `Atlas Cloud image generation failed: ${response.status}`;
    const code = error?.code ? ` (${error.code})` : "";
    throw new Error(`${message}${code}`);
  }

  const { dataUrl, text } = extractAtlasImage(payload);
  const { bytes, mimeType } = dataUrlToImage(dataUrl);
  return { dataUrl, bytes, mimeType, text };
}

export const atlasCloudImageProvider: ImageProvider = {
  billingSource: "atlascloud",
  generate: generateAtlasCloudImage,
  async healthCheck() {
    return true;
  },
};
