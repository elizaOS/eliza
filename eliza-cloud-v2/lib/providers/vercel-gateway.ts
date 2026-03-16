/**
 * Vercel AI Gateway provider implementation.
 *
 * Provides OpenAI-compatible API access through Vercel AI Gateway.
 */

import type {
  AIProvider,
  OpenAIChatRequest,
  OpenAIEmbeddingsRequest,
} from "./types";
import { logger } from "@/lib/utils/logger";

/**
 * Gateway error response structure.
 */
interface GatewayError {
  error: {
    message: string;
    type?: string;
    code?: string;
  };
}

/**
 * Vercel AI Gateway provider implementation.
 */
export class VercelGatewayProvider implements AIProvider {
  name = "vercel-gateway";
  private baseUrl = "https://ai-gateway.vercel.sh/v1";
  private apiKey: string;
  private timeout = 60000; // 60 seconds

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("Vercel AI Gateway API key is required");
    }
    this.apiKey = apiKey;
  }

  /**
   * Make a request to the gateway with timeout and better error handling
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      // Parse and propagate OpenAI-formatted errors
      if (!response.ok) {
        let errorData: GatewayError | null = null;

        try {
          const text = await response.text();
          errorData = JSON.parse(text);
        } catch {
          // If parsing fails, we'll use a generic error below
        }

        if (errorData?.error) {
          // Propagate the structured error from gateway
          throw {
            status: response.status,
            error: errorData.error,
          };
        }

        // Fallback for non-JSON errors
        throw {
          status: response.status,
          error: {
            message: `Gateway request failed with status ${response.status}`,
            type: "gateway_error",
            code: "gateway_request_failed",
          },
        };
      }

      return response;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        throw {
          status: 504,
          error: {
            message: "Gateway request timeout after 60 seconds",
            type: "timeout_error",
            code: "gateway_timeout",
          },
        };
      }

      // Re-throw structured errors
      throw error;
    }
  }

  async chatCompletions(request: OpenAIChatRequest): Promise<Response> {
    logger.debug("[Vercel Gateway] Forwarding chat completion request", {
      model: request.model,
      streaming: request.stream,
      messageCount: request.messages.length,
    });

    return await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
  }

  async embeddings(request: OpenAIEmbeddingsRequest): Promise<Response> {
    logger.debug("[Vercel Gateway] Forwarding embeddings request", {
      model: request.model,
      inputType: Array.isArray(request.input) ? "array" : "string",
    });

    return await this.fetchWithTimeout(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
  }

  async listModels(): Promise<Response> {
    return await this.fetchWithTimeout(`${this.baseUrl}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
  }

  async getModel(model: string): Promise<Response> {
    return await this.fetchWithTimeout(`${this.baseUrl}/models/${model}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
  }
}
