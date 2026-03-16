import type { IAgentRuntime } from "@elizaos/core";
import {
  getBaseUrl,
  getMaxTokens,
  getTimeoutSeconds,
  isBrowser,
} from "./environment";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ModelName,
} from "./types";

/**
 * HTTP client for interacting with the Copilot Proxy server.
 * Uses OpenAI-compatible API format.
 */
export class CopilotProxyClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly defaultMaxTokens: number;

  constructor(
    baseUrl: string,
    timeoutSeconds: number = 120,
    maxTokens: number = 8192,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutSeconds * 1000;
    this.defaultMaxTokens = maxTokens;
  }

  /**
   * Create a client from runtime configuration.
   */
  static fromRuntime(runtime: IAgentRuntime): CopilotProxyClient {
    const baseUrl = getBaseUrl(runtime);
    const timeoutSeconds = getTimeoutSeconds(runtime);
    const maxTokens = getMaxTokens(runtime);
    return new CopilotProxyClient(baseUrl, timeoutSeconds, maxTokens);
  }

  /**
   * Get the chat completions endpoint URL.
   */
  get completionsUrl(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  /**
   * Create a chat completion request.
   */
  async createChatCompletion(
    model: ModelName,
    messages: readonly ChatMessage[],
    options: {
      maxTokens?: number;
      temperature?: number;
      topP?: number;
      frequencyPenalty?: number;
      presencePenalty?: number;
      stop?: readonly string[];
      stream?: boolean;
    } = {},
  ): Promise<ChatCompletionResponse> {
    const request: ChatCompletionRequest = {
      model,
      messages,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature,
      top_p: options.topP,
      frequency_penalty: options.frequencyPenalty,
      presence_penalty: options.presencePenalty,
      stop: options.stop,
      stream: options.stream ?? false,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.completionsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Copilot Proxy doesn't require authentication
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new CopilotProxyError(
          `Request failed: ${response.status} ${response.statusText}`,
          response.status,
          errorText,
        );
      }

      const data = (await response.json()) as ChatCompletionResponse;
      return data;
    } catch (error) {
      if (error instanceof CopilotProxyError) {
        throw error;
      }
      if (error instanceof Error) {
        if (error.name === "AbortError") {
          throw new CopilotProxyError(
            `Request timed out after ${this.timeoutMs / 1000} seconds`,
            0,
            "timeout",
          );
        }
        throw new CopilotProxyError(
          `Network error: ${error.message}`,
          0,
          error.message,
        );
      }
      throw new CopilotProxyError("Unknown error occurred", 0, String(error));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Generate text using the chat completion API.
   */
  async generateText(
    model: ModelName,
    prompt: string,
    options: {
      system?: string;
      maxTokens?: number;
      temperature?: number;
      topP?: number;
      frequencyPenalty?: number;
      presencePenalty?: number;
      stop?: readonly string[];
    } = {},
  ): Promise<{
    text: string;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
  }> {
    const messages: ChatMessage[] = [];

    if (options.system) {
      messages.push({ role: "system", content: options.system });
    }

    messages.push({ role: "user", content: prompt });

    const response = await this.createChatCompletion(model, messages, {
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      topP: options.topP,
      frequencyPenalty: options.frequencyPenalty,
      presencePenalty: options.presencePenalty,
      stop: options.stop,
    });

    const text = response.choices[0]?.message?.content ?? "";
    const usage = response.usage
      ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        }
      : undefined;

    return { text, usage };
  }

  /**
   * Check if the proxy server is available.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Error class for Copilot Proxy errors.
 */
export class CopilotProxyError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(message: string, statusCode: number, responseBody: string) {
    super(message);
    this.name = "CopilotProxyError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

/**
 * Create a Copilot Proxy client from runtime configuration.
 */
export function createCopilotProxyClient(
  runtime: IAgentRuntime,
): CopilotProxyClient {
  return CopilotProxyClient.fromRuntime(runtime);
}
