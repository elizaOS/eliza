/** Implements Atlas Cloud's asynchronous image submit, poll, and download protocol. */
import { getAiProviderConfigurationError } from "../language-model";
import type { GeneratedImage, ImageGenRequest, ImageProvider } from "./types";

// Atlas Cloud image generation is an asynchronous predict/poll API (NOT the
// OpenAI chat-completions surface). Submit returns a prediction id; poll the
// prediction until status === "completed", then download outputs[0].
const ATLAS_IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;
const ATLAS_IMAGE_SUBMIT_TIMEOUT_MS = 30_000;
const ATLAS_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const ATLAS_POLL_INTERVAL_MS = 2_000;
const ATLAS_POLL_TIMEOUT_MS = 120_000;

interface AtlasImageTimingOptions {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  pollRequestTimeoutMs?: number;
}

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
  if (declaredLength > ATLAS_IMAGE_MAX_BYTES) {
    throw new Error("Atlas image download exceeded maximum size");
  }

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > ATLAS_IMAGE_MAX_BYTES) {
      throw new Error("Atlas image download exceeded maximum size");
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
    if (received > ATLAS_IMAGE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Atlas image download exceeded maximum size");
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

async function imageUrlToGeneratedImage(
  url: string,
  text = "",
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<GeneratedImage> {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(ATLAS_IMAGE_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Atlas image download failed: ${response.status}`);
  }

  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!mimeType?.startsWith("image/")) {
    throw new Error("Atlas image download returned non-image content");
  }

  const bytes = await readImageWithLimit(response);
  const dataUrl = `data:${mimeType};base64,${bytesToBase64(bytes)}`;
  return { dataUrl, bytes, mimeType, text };
}

function atlasBaseUrl(request: ImageGenRequest): string {
  return (request.apiKeys.ATLASCLOUD_BASE_URL || "https://api.atlascloud.ai").replace(/\/+$/, "");
}

interface AtlasPrediction {
  id?: string;
  status?: string;
  outputs?: unknown;
  error?: string;
  urls?: { get?: string };
}

function parsePrediction(payload: Record<string, unknown>): AtlasPrediction {
  const data = (payload.data ?? payload) as Record<string, unknown>;
  return {
    id: typeof data.id === "string" ? data.id : undefined,
    status: typeof data.status === "string" ? data.status : undefined,
    outputs: data.outputs,
    error: typeof data.error === "string" ? data.error : undefined,
    urls: data.urls as { get?: string } | undefined,
  };
}

function firstOutputUrl(outputs: unknown): string | undefined {
  if (!Array.isArray(outputs)) return undefined;
  const first = outputs[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && typeof (first as { url?: unknown }).url === "string") {
    return (first as { url: string }).url;
  }
  return undefined;
}

const TERMINAL_OK = new Set(["completed", "succeeded", "success"]);
const TERMINAL_FAIL = new Set(["failed", "error", "canceled", "cancelled"]);

/** Runs Atlas submit/poll/download through an injected fetch with per-request deadlines. */
export async function generateAtlasCloudImageWithFetch(
  request: ImageGenRequest,
  fetchImpl: typeof fetch,
  submitTimeoutMs = ATLAS_IMAGE_SUBMIT_TIMEOUT_MS,
  timing: AtlasImageTimingOptions = {},
): Promise<GeneratedImage> {
  const apiKey = request.apiKeys.ATLASCLOUD_API_KEY;
  if (!apiKey) {
    throw new Error(getAiProviderConfigurationError());
  }

  const baseUrl = atlasBaseUrl(request);
  const authHeader = { authorization: `Bearer ${apiKey}` };

  // 1. Submit the generation request. Per the Atlas API:
  //  - text-to-image models take just { model, prompt }.
  //  - edit / image-to-image models take an `images: [...]` array of source
  //    image urls/base64.
  //  - `size` uses the "WIDTH*HEIGHT" form (e.g. "2048*2048"); normalise a
  //    "WxH" input to that, otherwise pass through.
  const body: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
  };
  if (request.sourceImage) {
    body.images = [request.sourceImage];
  }
  if (request.size) {
    body.size = /^\d+x\d+$/i.test(request.size) ? request.size.replace(/x/i, "*") : request.size;
  }
  if (request.aspectRatio) {
    body.ratio = request.aspectRatio;
  }

  const submitResponse = await fetchImpl(`${baseUrl}/api/v1/model/generateImage`, {
    method: "POST",
    headers: { ...authHeader, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(submitTimeoutMs),
  });

  const submitPayload = (await submitResponse.json().catch(() => ({}))) as Record<string, unknown>;
  if (!submitResponse.ok) {
    const message =
      (typeof submitPayload.msg === "string" && submitPayload.msg) ||
      (typeof submitPayload.message === "string" && submitPayload.message) ||
      `Atlas image generation failed: ${submitResponse.status}`;
    throw new Error(message);
  }

  const submitted = parsePrediction(submitPayload);

  // Some models may return the image inline on submit; short-circuit if so.
  const inlineUrl = firstOutputUrl(submitted.outputs);
  if (inlineUrl) {
    return await imageUrlToGeneratedImage(inlineUrl, "", fetchImpl);
  }

  const predictionId = submitted.id;
  if (!predictionId) {
    throw new Error("Atlas image provider returned no prediction id");
  }
  const pollUrl = submitted.urls?.get ?? `${baseUrl}/api/v1/model/prediction/${predictionId}`;

  // 2. Poll the prediction until it terminates. The loop deadline only
  //    gates successful iterations; each poll fetch must also abort or a
  //    stalled Atlas GET hangs past ATLAS_POLL_TIMEOUT_MS.
  const pollIntervalMs = timing.pollIntervalMs ?? ATLAS_POLL_INTERVAL_MS;
  const pollTimeoutMs = timing.pollTimeoutMs ?? ATLAS_POLL_TIMEOUT_MS;
  const pollRequestTimeoutMs = timing.pollRequestTimeoutMs ?? ATLAS_IMAGE_SUBMIT_TIMEOUT_MS;
  const deadline = Date.now() + pollTimeoutMs;
  while (Date.now() < deadline) {
    const sleepMs = Math.min(Math.max(0, pollIntervalMs), Math.max(0, deadline - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, sleepMs));

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    const pollResponse = await fetchImpl(pollUrl, {
      headers: authHeader,
      signal: AbortSignal.timeout(Math.max(1, Math.min(pollRequestTimeoutMs, remainingMs))),
    });
    const pollPayload = (await pollResponse.json().catch(() => ({}))) as Record<string, unknown>;
    if (!pollResponse.ok) {
      throw new Error(`Atlas prediction poll failed: ${pollResponse.status}`);
    }

    const prediction = parsePrediction(pollPayload);
    const status = (prediction.status ?? "").toLowerCase();

    if (TERMINAL_FAIL.has(status)) {
      throw new Error(
        `Atlas image generation failed${prediction.error ? `: ${prediction.error}` : ""}`,
      );
    }

    if (TERMINAL_OK.has(status)) {
      const url = firstOutputUrl(prediction.outputs);
      if (!url) {
        throw new Error("Atlas image provider completed without an output image");
      }
      return await imageUrlToGeneratedImage(url, "", fetchImpl);
    }
  }

  throw new Error("Atlas image generation timed out");
}

export async function generateAtlasCloudImage(request: ImageGenRequest): Promise<GeneratedImage> {
  return generateAtlasCloudImageWithFetch(request, globalThis.fetch);
}

export const atlasCloudImageProvider: ImageProvider = {
  billingSource: "atlascloud",
  generate: generateAtlasCloudImage,
  async healthCheck() {
    return true;
  },
};
