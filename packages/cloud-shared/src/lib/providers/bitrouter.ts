/**
 * BitRouter provider implementation.
 *
 * Provides OpenAI-compatible API access through a self-hosted or BitRouter
 * Cloud gateway. This is the principal cloud model router.
 */

import { logger } from "../utils/logger";
import { type ProviderLabel, providerFetchWithTimeout } from "./_http";
import { isRetryableProviderError } from "./failover";
import { stripOpenRouterRoutingSuffix, toBitRouterModelId } from "./model-id-translation";
import type {
  AIProvider,
  OpenAIChatRequest,
  OpenAIEmbeddingsRequest,
  ProviderRequestOptions,
} from "./types";

const BITROUTER_LABEL: ProviderLabel = {
  display: "BitRouter",
  errorType: "bitrouter_error",
  requestFailedCode: "bitrouter_request_failed",
  timeoutCode: "bitrouter_timeout",
};

const DEFAULT_BITROUTER_BASE_URL = "https://api.bitrouter.ai/v1";

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  const normalized = (trimmed || DEFAULT_BITROUTER_BASE_URL).replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

export class BitRouterProvider implements AIProvider {
  name = "bitrouter";
  private baseUrl: string;
  private apiKey: string;
  private timeout = 2 * 60000; // 2 minutes

  constructor(apiKey: string, baseUrl?: string) {
    if (!apiKey) {
      throw new Error("BitRouter API key is required");
    }
    this.apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(baseUrl);
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
    return providerFetchWithTimeout(url, options, timeoutMs, BITROUTER_LABEL);
  }

  async chatCompletions(
    request: OpenAIChatRequest,
    options?: ProviderRequestOptions,
  ): Promise<Response> {
    const { providerOptions: _providerOptions, ...rest } = request;
    return await this.postChatCompletions(toBitRouterModelId(rest.model), rest, options, true);
  }

  /**
   * POSTs a chat completion, with one same-gateway retry for OpenRouter routing
   * suffixes: if `model` carries `:nitro` / `:floor` and the request fails with a
   * retryable upstream error, retry once with the suffix stripped so a healthy
   * default upstream serves the same model instead of hard-failing on the
   * throughput-/price-priority path (bitrouter/bitrouter#572).
   */
  private async postChatCompletions(
    model: string,
    rest: Omit<OpenAIChatRequest, "providerOptions">,
    options: ProviderRequestOptions | undefined,
    allowRoutingFallback: boolean,
  ): Promise<Response> {
    const body = model === rest.model ? rest : { ...rest, model };

    logger.debug("[BitRouter] Forwarding chat completion request", {
      model,
      streaming: rest.stream,
      messageCount: rest.messages.length,
    });

    try {
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
    } catch (error) {
      const baseModel = allowRoutingFallback ? stripOpenRouterRoutingSuffix(model) : null;
      if (baseModel && isRetryableProviderError(error)) {
        logger.warn(
          "[BitRouter] Routing-suffixed model %s failed (%d); retrying base %s",
          model,
          error.status,
          baseModel,
        );
        return await this.postChatCompletions(baseModel, rest, options, false);
      }
      throw error;
    }
  }

  async embeddings(request: OpenAIEmbeddingsRequest): Promise<Response> {
    const translatedModel = toBitRouterModelId(request.model);
    const body =
      translatedModel === request.model ? request : { ...request, model: translatedModel };

    logger.debug("[BitRouter] Forwarding embeddings request", {
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
        Accept: "application/json",
      },
    });
  }

  async getModel(model: string): Promise<Response> {
    const translatedModel = toBitRouterModelId(model);
    return await this.fetchWithTimeout(`${this.baseUrl}/models/${translatedModel}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
      },
    });
  }
}
