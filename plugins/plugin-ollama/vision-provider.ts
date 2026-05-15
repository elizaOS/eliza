/**
 * Ollama Vision Analysis Provider
 *
 * Local vision model provider that talks to an Ollama server (default
 * http://localhost:11434). Posts base64-encoded images to /api/chat with the
 * configured vision model (llava, llama3.2-vision, etc.) and returns the
 * model's textual description.
 *
 * Extracted from packages/agent/src/providers/media-provider.ts in Phase 4B —
 * cloud vision providers (OpenAI, Google, XAI, Anthropic) stay in agent because
 * they're thin API wrappers; this one belongs with the rest of the Ollama
 * integration.
 */

import { logger } from "@elizaos/core";

// --- Local config shape (mirrors @elizaos/shared VisionOllamaConfig) ---

export interface VisionOllamaConfig {
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  autoDownload?: boolean;
}

// --- Local result/option types (structural match with agent's VisionAnalysisProvider) ---

export interface MediaProviderResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface VisionAnalysisResult {
  description: string;
  labels?: string[];
  confidence?: number;
}

export interface VisionAnalysisOptions {
  imageUrl?: string;
  imageBase64?: string;
  prompt?: string;
  maxTokens?: number;
}

// --- Internal helpers ---

function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

async function withProviderErrorBoundary<T>(
  providerName: string,
  run: () => Promise<MediaProviderResult<T>>,
): Promise<MediaProviderResult<T>> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `[${providerName}] Network error: ${message}`,
    };
  }
}

// --- Provider ---

export class OllamaVisionProvider {
  name = "ollama";
  private baseUrl: string;
  private model: string;
  private maxTokens: number;
  private autoDownload: boolean;
  private modelChecked = false;

  constructor(config: VisionOllamaConfig) {
    this.baseUrl = config.baseUrl ?? "http://localhost:11434";
    this.model = config.model ?? "llava";
    this.maxTokens = config.maxTokens ?? 1024;
    this.autoDownload = config.autoDownload ?? true;
  }

  private async ensureModelAvailable(): Promise<void> {
    if (this.modelChecked) return;

    try {
      const response = await fetchWithTimeout(
        `${this.baseUrl}/api/tags`,
        {},
        120_000,
      );
      if (!response.ok) {
        throw new Error(`Ollama server not reachable: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        models?: Array<{ name: string }>;
      };
      const models = data.models ?? [];
      const hasModel = models.some(
        (m) => m.name === this.model || m.name.startsWith(`${this.model}:`),
      );

      if (!hasModel && this.autoDownload) {
        logger.info(
          `[ollama-vision] Model ${this.model} not found, downloading...`,
        );
        await this.downloadModel();
      } else if (!hasModel) {
        throw new Error(
          `Ollama model ${this.model} not found. Run 'ollama pull ${this.model}' or enable autoDownload.`,
        );
      }

      this.modelChecked = true;
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("Ollama server not reachable")
      ) {
        throw err;
      }
      throw new Error(
        `Failed to check Ollama models: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async downloadModel(): Promise<void> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/pull`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: this.model, stream: false }),
      },
      300_000,
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to download model ${this.model}: ${text}`);
    }

    await response.json();
    logger.info(`[ollama-vision] Model ${this.model} downloaded successfully`);
  }

  async analyze(
    options: VisionAnalysisOptions,
  ): Promise<MediaProviderResult<VisionAnalysisResult>> {
    try {
      await this.ensureModelAvailable();
    } catch (err) {
      return {
        success: false,
        error: `Ollama setup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let imageData = options.imageBase64;
    if (!imageData && options.imageUrl) {
      try {
        const imageResponse = await fetchWithTimeout(
          options.imageUrl,
          {},
          120_000,
        );
        if (!imageResponse.ok) {
          return {
            success: false,
            error: `Failed to fetch image: ${imageResponse.statusText}`,
          };
        }
        const buffer = await imageResponse.arrayBuffer();
        imageData = Buffer.from(buffer).toString("base64");
      } catch (err) {
        return {
          success: false,
          error: `Failed to fetch image: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (!imageData) {
      return {
        success: false,
        error: "No image provided (imageUrl or imageBase64 required)",
      };
    }

    return withProviderErrorBoundary(this.name, async () => {
      const response = await fetchWithTimeout(
        `${this.baseUrl}/api/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            messages: [
              {
                role: "user",
                content: options.prompt ?? "Describe this image in detail.",
                images: [imageData],
              },
            ],
            stream: false,
            options: {
              num_predict: this.maxTokens,
            },
          }),
        },
        120_000,
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `Ollama error: ${text}` };
      }

      const data = (await response.json()) as {
        message?: { content?: string };
      };
      const description = data.message?.content;
      if (!description) {
        return { success: false, error: "No description returned from Ollama" };
      }

      return {
        success: true,
        data: { description },
      };
    });
  }
}
