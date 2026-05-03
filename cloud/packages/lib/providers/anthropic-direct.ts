/**
 * Anthropic direct provider.
 *
 * Used as a per-family fallback when OpenRouter is unavailable for an
 * `anthropic/*` model. Calls Anthropic's OpenAI-compatible endpoint at
 * `https://api.anthropic.com/v1/chat/completions`, stripping the
 * `anthropic/` prefix. Anthropic's OpenAI compat layer covers chat
 * completions but not embeddings, models listing, or the Responses API,
 * so those methods throw structured "not supported" errors that the
 * failover layer treats as non-retryable.
 */

import { logger } from "@/lib/utils/logger";
import { type ProviderLabel, providerFetchWithTimeout } from "./_http";
import type {
  AIProvider,
  OpenAIChatRequest,
  OpenAIEmbeddingsRequest,
  ProviderHttpError,
  ProviderRequestOptions,
} from "./types";

const ANTHROPIC_LABEL: ProviderLabel = {
  display: "Anthropic",
  errorType: "anthropic_error",
  requestFailedCode: "anthropic_request_failed",
  timeoutCode: "anthropic_timeout",
};

function stripAnthropicPrefix(model: string): string {
  return model.startsWith("anthropic/") ? model.slice("anthropic/".length) : model;
}

function notSupportedError(operation: string): never {
  const httpError: ProviderHttpError = {
    status: 400,
    error: {
      message: `Anthropic direct provider does not support ${operation}`,
      type: "unsupported_operation",
      code: "anthropic_direct_unsupported",
    },
  };
  throw httpError;
}

export class AnthropicDirectProvider implements AIProvider {
  name = "anthropic";
  private baseUrl = "https://api.anthropic.com/v1";
  private apiKey: string;
  private timeout = 2 * 60000;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("Anthropic API key is required");
    }
    this.apiKey = apiKey;
  }

  private getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number = this.timeout,
  ): Promise<Response> {
    return providerFetchWithTimeout(url, options, timeoutMs, ANTHROPIC_LABEL);
  }

  async chatCompletions(
    request: OpenAIChatRequest,
    options?: ProviderRequestOptions,
  ): Promise<Response> {
    const { providerOptions: _providerOptions, ...rest } = request;
    const body = { ...rest, model: stripAnthropicPrefix(rest.model) };

    logger.debug("[Anthropic Direct] Forwarding chat completion request", {
      model: body.model,
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

  async embeddings(_request: OpenAIEmbeddingsRequest): Promise<Response> {
    notSupportedError("embeddings");
  }

  async listModels(): Promise<Response> {
    notSupportedError("listModels");
  }

  async getModel(_model: string): Promise<Response> {
    notSupportedError("getModel");
  }
}
