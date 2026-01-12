import type {
  ChatCompletionResponse,
  EmbeddingParams,
  EmbeddingResponse,
  GatewayConfig,
  ImageDescriptionParams,
  ImageDescriptionResult,
  ImageGenerationParams,
  ImageGenerationResponse,
  ImageGenerationResult,
  TextGenerationParams,
} from "../types";
import { GatewayError } from "../types";
import { modelSupportsTemperature } from "../utils/config";

export class GatewayClient {
  private readonly config: GatewayConfig;

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  private url(endpoint: string): string {
    const base = this.config.baseUrl.replace(/\/$/, "");
    return `${base}${endpoint}`;
  }

  private async request<T>(endpoint: string, options: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(this.url(endpoint), {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      });

      if (!response.ok) {
        let message: string;
        try {
          const errorData = (await response.json()) as {
            error?: { message?: string };
          };
          message = errorData?.error?.message || response.statusText;
        } catch {
          message = response.statusText;
        }
        throw new GatewayError(
          `Gateway API error (${response.status}): ${message}`,
          response.status
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new GatewayError("Request timeout");
      }
      throw new GatewayError(
        `Network error: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async generateText(params: TextGenerationParams): Promise<string> {
    const model = params.model || this.config.largeModel;

    const messages: Array<{ role: string; content: string }> = [];
    if (params.system) {
      messages.push({ role: "system", content: params.system });
    }
    messages.push({ role: "user", content: params.prompt });

    const body: Record<
      string,
      string | number | boolean | string[] | Array<{ role: string; content: string }>
    > = {
      model,
      messages,
    };

    if (modelSupportsTemperature(model)) {
      if (params.temperature !== undefined) {
        body.temperature = params.temperature;
      }
      if (params.frequencyPenalty !== undefined) {
        body.frequency_penalty = params.frequencyPenalty;
      }
      if (params.presencePenalty !== undefined) {
        body.presence_penalty = params.presencePenalty;
      }
      if (params.stopSequences !== undefined) {
        body.stop = params.stopSequences;
      }
      if (params.maxTokens !== undefined) {
        body.max_tokens = params.maxTokens;
      }
    } else {
      if (params.maxTokens !== undefined) {
        body.max_completion_tokens = params.maxTokens;
      }
    }

    const response = await this.request<ChatCompletionResponse>("/chat/completions", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!response.choices || response.choices.length === 0) {
      throw new GatewayError("API returned no choices");
    }

    const content = response.choices[0].message.content;
    if (content === null) {
      throw new GatewayError("API returned empty content");
    }

    return content;
  }

  async *streamText(params: TextGenerationParams): AsyncGenerator<string, void, void> {
    const model = params.model || this.config.largeModel;

    const messages: Array<{ role: string; content: string }> = [];
    if (params.system) {
      messages.push({ role: "system", content: params.system });
    }
    messages.push({ role: "user", content: params.prompt });

    const body: Record<
      string,
      string | number | boolean | Array<{ role: string; content: string }>
    > = {
      model,
      messages,
      stream: true,
    };

    if (modelSupportsTemperature(model)) {
      if (params.temperature !== undefined) {
        body.temperature = params.temperature;
      }
      if (params.maxTokens !== undefined) {
        body.max_tokens = params.maxTokens;
      }
    } else {
      if (params.maxTokens !== undefined) {
        body.max_completion_tokens = params.maxTokens;
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(this.url("/chat/completions"), {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new GatewayError(
          `Gateway API error (${response.status}): ${response.statusText}`,
          response.status
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new GatewayError("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") return;

          try {
            const chunk = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const content = chunk.choices?.[0]?.delta?.content;
            if (content) {
              yield content;
            }
          } catch {}
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async createEmbedding(params: EmbeddingParams): Promise<number[]> {
    const model = params.model || this.config.embeddingModel;
    const dimensions = params.dimensions || this.config.embeddingDimensions;

    const body: Record<string, unknown> = {
      model,
      input: params.text,
    };

    if (dimensions) {
      body.dimensions = dimensions;
    }

    const response = await this.request<EmbeddingResponse>("/embeddings", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!response.data || response.data.length === 0) {
      throw new GatewayError("API returned empty embedding data");
    }

    return response.data[0].embedding;
  }

  // =========================================================================
  // Image Generation
  // =========================================================================

  /**
   * Generate images.
   */
  async generateImage(params: ImageGenerationParams): Promise<ImageGenerationResult[]> {
    const model = params.model || this.config.imageModel;

    const body: Record<string, string | number | undefined> = {
      model,
      prompt: params.prompt,
    };

    if (params.n !== undefined) body.n = params.n;
    if (params.size !== undefined) body.size = params.size;
    if (params.quality !== undefined) body.quality = params.quality;
    if (params.style !== undefined) body.style = params.style;

    const response = await this.request<ImageGenerationResponse>("/images/generations", {
      method: "POST",
      body: JSON.stringify(body),
    });

    return response.data.map((item) => ({
      url: item.url,
      revisedPrompt: item.revised_prompt,
    }));
  }

  // =========================================================================
  // Image Description
  // =========================================================================

  /**
   * Describe/analyze an image using vision capabilities.
   */
  async describeImage(params: ImageDescriptionParams): Promise<ImageDescriptionResult> {
    const model = params.model || "gpt-5-mini";
    const prompt =
      params.prompt || "Please analyze this image and provide a title and detailed description.";
    const maxTokens = params.maxTokens || 8192;

    const body = {
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: params.imageUrl } },
          ],
        },
      ],
      max_tokens: maxTokens,
    };

    const response = await this.request<ChatCompletionResponse>("/chat/completions", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!response.choices || response.choices.length === 0) {
      throw new GatewayError("API returned no choices for image description");
    }

    const content = response.choices[0].message.content;
    if (content === null) {
      throw new GatewayError("API returned empty image description");
    }

    let title = "Image Analysis";
    let description = content;

    const titleMatch = /title[:\s]+(.+?)(?:\n|$)/i.exec(content);
    if (titleMatch) {
      title = titleMatch[1].trim();
      description = content.replace(/title[:\s]+.+?(?:\n|$)/i, "").trim();
    }

    return { title, description };
  }

  async generateObject(params: {
    prompt: string;
    model?: string;
    temperature?: number;
  }): Promise<Record<string, unknown>> {
    const model = params.model || this.config.smallModel;
    const prompt = `Respond with only valid JSON. ${params.prompt}`;

    const response = await this.generateText({
      prompt,
      model,
      temperature: params.temperature,
    });

    let cleaned = response.trim();
    if (cleaned.startsWith("```json")) {
      cleaned = cleaned.slice(7);
    }
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith("```")) {
      cleaned = cleaned.slice(0, -3);
    }

    try {
      return JSON.parse(cleaned.trim()) as Record<string, unknown>;
    } catch {
      throw new GatewayError(`Failed to parse JSON response: ${cleaned}`);
    }
  }
}
