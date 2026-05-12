/**
 * OpenRouter provider implementation.
 *
 * Provides OpenAI-compatible API access through OpenRouter.
 * Primary AI provider for all non-Groq traffic.
 */

import { logger } from "@/lib/utils/logger";
import { type ProviderLabel, providerFetchWithTimeout } from "./_http";
import { toOpenRouterModelId } from "./model-id-translation";
import type {
  AIProvider,
  OpenAIChatRequest,
  OpenAIEmbeddingsRequest,
  ProviderRequestOptions,
} from "./types";

const OPENROUTER_LABEL: ProviderLabel = {
  display: "OpenRouter",
  errorType: "openrouter_error",
  requestFailedCode: "openrouter_request_failed",
  timeoutCode: "openrouter_timeout",
};

export class OpenRouterProvider implements AIProvider {
  name = "openrouter";
  private baseUrl = "https://openrouter.ai/api/v1";
  private apiKey: string;
  private timeout = 2 * 60000; // 2 minutes

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("OpenRouter API key is required");
    }
    this.apiKey = apiKey;
  }

  private getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://eliza.cloud",
      "X-Title": "Eliza Cloud",
    };
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number = this.timeout,
  ): Promise<Response> {
    return providerFetchWithTimeout(url, options, timeoutMs, OPENROUTER_LABEL);
  }

  async chatCompletions(
    request: OpenAIChatRequest,
    options?: ProviderRequestOptions,
  ): Promise<Response> {
    const { providerOptions: _providerOptions, ...rest } = request;
    const translatedModel = toOpenRouterModelId(rest.model);
    const body = translatedModel === rest.model ? rest : { ...rest, model: translatedModel };

    logger.debug("[OpenRouter] Forwarding chat completion request", {
      model: translatedModel,
      streaming: request.stream,
      messageCount: request.messages.length,
    });

    return await this.fetchWithTimeout(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(body),
        signal: options?.signal,
      },
      options?.timeoutMs,
    );
  }

  async embeddings(request: OpenAIEmbeddingsRequest): Promise<Response> {
    const translatedModel = toOpenRouterModelId(request.model);
    const body =
      translatedModel === request.model ? request : { ...request, model: translatedModel };

    logger.debug("[OpenRouter] Forwarding embeddings request", {
      model: translatedModel,
      inputType: Array.isArray(request.input) ? "array" : "string",
    });

    return await this.fetchWithTimeout(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });
  }

  async listModels(): Promise<Response> {
    return await this.fetchWithTimeout(`${this.baseUrl}/models?output_modalities=all`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
  }

  async getModel(model: string): Promise<Response> {
    const translatedModel = toOpenRouterModelId(model);
    return await this.fetchWithTimeout(`${this.baseUrl}/models/${translatedModel}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
  }
}
