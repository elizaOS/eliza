/**
 * Cerebras direct provider.
 *
 * Cerebras exposes an OpenAI-compatible `/chat/completions` API, but its native
 * model ids are bare (`gemma-4-31b`, `gpt-oss-120b`, `zai-glm-4.7`). Dedicated agents can emit
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
  ProviderHttpError,
  ProviderRequestOptions,
} from "./types";

const CEREBRAS_LABEL: ProviderLabel = {
  display: "Cerebras",
  errorType: "cerebras_error",
  requestFailedCode: "cerebras_request_failed",
  timeoutCode: "cerebras_timeout",
};

const RESPONSE_FORMAT_DROPPED_HEADER = "x-eliza-response-format";

function isResponseFormatUnsupported(error: unknown): error is ProviderHttpError {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return false;
  }
  const httpError = error as ProviderHttpError;
  if (httpError.status !== 400) return false;
  const message = httpError.error?.message ?? "";
  const code = httpError.error?.code ?? "";
  return /response_format/i.test(`${message} ${code}`);
}

function withResponseFormatDroppedHeader(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(RESPONSE_FORMAT_DROPPED_HEADER, "dropped");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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
      // error-policy:J4 explicit provider degrade — Cerebras can reject
      // OpenAI-compatible structured-output hints; retry once without that hint
      // and mark the response so callers know upstream did not enforce it.
      if (!request.response_format || !isResponseFormatUnsupported(error)) {
        throw error;
      }
      const { response_format: _responseFormat, ...degradedBody } = body;
      logger.warn("[Cerebras Direct] Upstream rejected response_format; retrying once without it", {
        model: degradedBody.model,
        responseFormatType: request.response_format.type,
      });
      const degradedResponse = await this.fetchWithTimeout(
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: this.getHeaders(),
          body: JSON.stringify(degradedBody),
          signal: options?.signal,
        },
        options?.timeoutMs,
      );
      return withResponseFormatDroppedHeader(degradedResponse);
    }
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
