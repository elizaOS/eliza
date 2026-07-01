/**
 * OpenRouter provider implementation.
 *
 * Direct, BYOK access to OpenRouter's OpenAI-compatible gateway
 * (`https://openrouter.ai/api/v1`). This is the **fallback** the cloud uses
 * when the primary router (BitRouter today, native routing tomorrow) returns a
 * retryable upstream error — see `getProviderForModelWithFallback` and the
 * AI-SDK `withOpenRouterFallback` wrapper in `language-model.ts`.
 *
 * OpenRouter and BitRouter share the same catalog id format (`x-ai/…`,
 * `anthropic/…`, `openai/…`) and the same `:nitro` / `:floor` routing-suffix
 * convention, so this provider reuses `toBitRouterModelId` for translation and
 * mirrors BitRouter's single-shot-suffix → transport-retry-base failover. When
 * BitRouter is removed (migration Phase 3) this becomes the sole gateway
 * provider and the parallel with `bitrouter.ts` collapses.
 */

import { logger } from "../utils/logger";
import { type ProviderLabel, type ProviderRetryOptions, providerFetchWithTimeout } from "./_http";
import { isRetryableProviderError } from "./failover";
import { stripOpenRouterRoutingSuffix, toBitRouterModelId } from "./model-id-translation";
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

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  const normalized = (trimmed || DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

export class OpenRouterProvider implements AIProvider {
  name = "openrouter";
  private baseUrl: string;
  private apiKey: string;
  private timeout = 2 * 60000; // 2 minutes
  /** Transient-retry budget applied to the terminal (base/default) upstream path. */
  private retry?: ProviderRetryOptions;

  constructor(apiKey: string, baseUrl?: string, retry?: ProviderRetryOptions) {
    if (!apiKey) {
      throw new Error("OpenRouter API key is required");
    }
    this.apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.retry = retry;
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
    retry?: ProviderRetryOptions,
  ): Promise<Response> {
    return providerFetchWithTimeout(url, options, timeoutMs, OPENROUTER_LABEL, retry);
  }

  async chatCompletions(
    request: OpenAIChatRequest,
    options?: ProviderRequestOptions,
  ): Promise<Response> {
    const { providerOptions: _providerOptions, ...rest } = request;
    return await this.postChatCompletions(toBitRouterModelId(rest.model), rest, options, true);
  }

  /**
   * POSTs a chat completion. OpenRouter routing suffixes (`:nitro` / `:floor`)
   * are throughput/price PREFERENCES, not part of model identity: if the
   * suffixed model returns a retryable upstream error we drop the suffix and
   * retry the base id once (default routing), so the priority attempt is a
   * single shot that never burns the transport-retry budget on a saturated
   * pool. The terminal (base/suffix-less) model then gets the transient-retry
   * budget. Streaming is never retried (a consumed SSE body can't replay).
   */
  private async postChatCompletions(
    model: string,
    rest: Omit<OpenAIChatRequest, "providerOptions">,
    options: ProviderRequestOptions | undefined,
    allowRoutingFallback: boolean,
  ): Promise<Response> {
    const body = model === rest.model ? rest : { ...rest, model };

    logger.debug("[OpenRouter] Forwarding chat completion request", {
      model,
      streaming: rest.stream,
      messageCount: rest.messages.length,
    });

    const baseModel = allowRoutingFallback ? stripOpenRouterRoutingSuffix(model) : null;
    const isPriorityRoutingAttempt = baseModel !== null;
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
        rest.stream || isPriorityRoutingAttempt ? { maxRetries: 0 } : this.retry,
      );
    } catch (error) {
      if (baseModel && isRetryableProviderError(error)) {
        logger.warn(
          "[OpenRouter] Routing-suffixed model %s failed (%d); retrying base %s",
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
    return await this.fetchWithTimeout(`${this.baseUrl}/models`, {
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
