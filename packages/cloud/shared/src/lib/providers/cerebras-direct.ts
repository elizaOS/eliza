/**
 * Cerebras direct provider.
 *
 * Cerebras exposes an OpenAI-compatible `/chat/completions` API, but its native
 * model ids are bare (`gpt-oss-120b`, `zai-glm-4.7`). Dedicated agents can emit
 * decorated OpenRouter-style ids such as `openai/gpt-oss-120b:nitro`; collapse
 * those before forwarding so raw-fetch app chat matches the AI-SDK route.
 */

import { logger } from "../utils/logger";
import { type ProviderLabel, providerFetchWithTimeout } from "./_http";
import { canonicalizeCerebrasModelId } from "./language-model";
import type {
  AIProvider,
  OpenAIChatRequest,
  OpenAIEmbeddingsRequest,
  ProviderRequestOptions,
} from "./types";

const CEREBRAS_LABEL: ProviderLabel = {
  display: "Cerebras",
  errorType: "cerebras_error",
  requestFailedCode: "cerebras_request_failed",
  timeoutCode: "cerebras_timeout",
};

export class CerebrasDirectProvider implements AIProvider {
  name = "cerebras";
  private baseUrl = "https://api.cerebras.ai/v1";
  private apiKey: string;
  private timeout = 2 * 60000;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("Cerebras API key is required");
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
    return providerFetchWithTimeout(url, options, timeoutMs, CEREBRAS_LABEL);
  }

  async chatCompletions(
    request: OpenAIChatRequest,
    options?: ProviderRequestOptions,
  ): Promise<Response> {
    const { providerOptions: _providerOptions, ...rest } = request;
    const body = { ...rest, model: canonicalizeCerebrasModelId(rest.model) };

    logger.debug("[Cerebras Direct] Forwarding chat completion request", {
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
    return new Response(
      JSON.stringify({
        error: {
          message: "Cerebras does not provide the configured embeddings model",
          type: "invalid_request_error",
          code: "unsupported_model",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  async listModels(): Promise<Response> {
    return await this.fetchWithTimeout(`${this.baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
  }

  async getModel(model: string): Promise<Response> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/models/${canonicalizeCerebrasModelId(model)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
      },
    );
  }
}
