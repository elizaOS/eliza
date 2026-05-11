/**
 * OpenAI direct provider.
 *
 * Used as a per-family fallback when OpenRouter is unavailable for an
 * `openai/*` model. Strips the `openai/` prefix before calling the
 * upstream because OpenAI's API expects bare ids (`gpt-5.4-mini`).
 */

import { logger } from "@/lib/utils/logger";
import { type ProviderLabel, providerFetchWithTimeout } from "./_http";
import type {
  AIProvider,
  OpenAIChatRequest,
  OpenAIEmbeddingsRequest,
  ProviderRequestOptions,
} from "./types";

const OPENAI_LABEL: ProviderLabel = {
  display: "OpenAI",
  errorType: "openai_error",
  requestFailedCode: "openai_request_failed",
  timeoutCode: "openai_timeout",
};

function stripOpenAIPrefix(model: string): string {
  return model.startsWith("openai/") ? model.slice("openai/".length) : model;
}

export class OpenAIDirectProvider implements AIProvider {
  name = "openai";
  private baseUrl: string;
  private apiKey: string;
  private timeout = 2 * 60000;

  constructor(apiKey: string, baseUrl = "https://api.openai.com/v1") {
    if (!apiKey) {
      throw new Error("OpenAI API key is required");
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
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
    return providerFetchWithTimeout(url, options, timeoutMs, OPENAI_LABEL);
  }

  async chatCompletions(
    request: OpenAIChatRequest,
    options?: ProviderRequestOptions,
  ): Promise<Response> {
    const { providerOptions: _providerOptions, ...rest } = request;
    const body = { ...rest, model: stripOpenAIPrefix(rest.model) };

    logger.debug("[OpenAI Direct] Forwarding chat completion request", {
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

  async embeddings(request: OpenAIEmbeddingsRequest): Promise<Response> {
    const body = { ...request, model: stripOpenAIPrefix(request.model) };

    logger.debug("[OpenAI Direct] Forwarding embeddings request", {
      model: body.model,
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
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
  }

  async getModel(model: string): Promise<Response> {
    return await this.fetchWithTimeout(`${this.baseUrl}/models/${stripOpenAIPrefix(model)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
  }
}
