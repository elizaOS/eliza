import { getAiProviderConfigurationError } from "../language-model";
import type { GeneratedImage, ImageGenRequest, ImageProvider } from "./types";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function imageUrlToGeneratedImage(url: string, text = ""): Promise<GeneratedImage> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fal image download failed: ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const mimeType = response.headers.get("content-type")?.split(";")[0] || "image/png";
  const dataUrl = `data:${mimeType};base64,${bytesToBase64(bytes)}`;
  return { dataUrl, bytes, mimeType, text };
}

function extractFalImageUrl(payload: Record<string, unknown>): { url: string; text: string } {
  const images = Array.isArray(payload.images) ? payload.images : [];
  const firstImage = images[0] as { url?: unknown } | undefined;
  const url = typeof firstImage?.url === "string" ? firstImage.url : undefined;
  if (!url) {
    throw new Error("fal image provider returned no image url");
  }

  const text = typeof payload.description === "string" ? payload.description : "";
  return { url, text };
}

export async function generateFalImage(request: ImageGenRequest): Promise<GeneratedImage> {
  const apiKey = request.apiKeys.FAL_KEY ?? request.apiKeys.FAL_API_KEY;
  if (!apiKey) {
    throw new Error(getAiProviderConfigurationError());
  }

  const response = await fetch(`https://fal.run/${request.model}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      prompt: request.prompt,
      ...(request.sourceImage ? { image_url: request.sourceImage } : {}),
      ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
      ...(request.size ? { image_size: request.size } : {}),
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = typeof payload.detail === "string" ? payload.detail : undefined;
    throw new Error(detail ?? `fal image generation failed: ${response.status}`);
  }

  const { url, text } = extractFalImageUrl(payload);
  return await imageUrlToGeneratedImage(url, text);
}

export const falImageProvider: ImageProvider = {
  billingSource: "fal",
  generate: generateFalImage,
  async healthCheck() {
    return true;
  },
};
