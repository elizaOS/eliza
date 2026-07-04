// Defines cloud shared fal image generation behavior for backend service consumers.
import { getAiProviderConfigurationError } from "../language-model";
import type { GeneratedImage, ImageGenRequest, ImageProvider } from "./types";

const FAL_IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;
const FAL_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function readImageWithLimit(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > FAL_IMAGE_MAX_BYTES) {
    throw new Error("fal image download exceeded maximum size");
  }

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > FAL_IMAGE_MAX_BYTES) {
      throw new Error("fal image download exceeded maximum size");
    }
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > FAL_IMAGE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("fal image download exceeded maximum size");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function imageUrlToGeneratedImage(url: string, text = ""): Promise<GeneratedImage> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FAL_IMAGE_DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`fal image download failed: ${response.status}`);
  }

  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!mimeType?.startsWith("image/")) {
    throw new Error("fal image download returned non-image content");
  }

  const bytes = await readImageWithLimit(response);
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

  // Overridable for deterministic tests (same convention as OPENROUTER_BASE_URL
  // and the queue client's FAL_QUEUE_BASE_URL).
  const baseUrl = (request.apiKeys.FAL_RUN_BASE_URL ?? "https://fal.run").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/${request.model}`, {
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
