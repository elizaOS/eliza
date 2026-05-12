/**
 * Vast.ai Serverless provider.
 *
 * Forwards OpenAI-compatible chat completions to a Vast Serverless endpoint
 * fronted by llama.cpp's `llama-server` (via PyWorker). The endpoint URL and
 * auth token come from `VAST_BASE_URL` and `VAST_API_KEY` because each Vast
 * endpoint has a unique routing URL — we don't bake one in.
 *
 * Catalog ids look like `vast/eliza-1-27b`. The upstream llama-server
 * is launched with `--alias <catalog id>` so the model id round-trips
 * unchanged; `VAST_NATIVE_MODEL_ID_MAP` is kept available so we can register
 * additional quants/variants later. Vast itself manages autoscaling, queueing,
 * and load balancing — we are a thin pass-through.
 */

import { getVastApiModelId, VAST_NATIVE_MODELS } from "@/lib/models";
import { logger } from "@/lib/utils/logger";
import { type ProviderLabel, providerFetchWithTimeout } from "./_http";
import type {
  AIProvider,
  OpenAIChatRequest,
  OpenAIEmbeddingsRequest,
  ProviderRequestOptions,
} from "./types";

const VAST_LABEL: ProviderLabel = {
  display: "Vast",
  errorType: "vast_error",
  requestFailedCode: "vast_request_failed",
  timeoutCode: "vast_timeout",
};

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export class VastProvider implements AIProvider {
  name = "vast";
  private baseUrl: string;
  private apiKey: string;
  private timeout = 2 * 60000;

  constructor(apiKey: string, baseUrl: string) {
    if (!apiKey) {
      throw new Error("Vast API key is required");
    }
    if (!baseUrl) {
      throw new Error("Vast base URL is required");
    }
    this.apiKey = apiKey;
    this.baseUrl = trimTrailingSlash(baseUrl);
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
    return providerFetchWithTimeout(url, options, timeoutMs, VAST_LABEL);
  }

  async chatCompletions(
    request: OpenAIChatRequest,
    options?: ProviderRequestOptions,
  ): Promise<Response> {
    const { providerOptions: _providerOptions, ...rest } = request;
    const body = { ...rest, model: getVastApiModelId(rest.model) };

    logger.debug("[Vast] Forwarding chat completion request", {
      model: body.model,
      streaming: request.stream,
      messageCount: request.messages.length,
    });

    return await this.fetchWithTimeout(
      `${this.baseUrl}/v1/chat/completions`,
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
    return Response.json(
      {
        error: {
          message: "Vast embeddings are not supported by this provider adapter",
          type: "invalid_request_error",
          code: "unsupported_operation",
        },
      },
      { status: 400 },
    );
  }

  async listModels(): Promise<Response> {
    return Response.json({
      object: "list",
      data: VAST_NATIVE_MODELS,
    });
  }

  async getModel(model: string): Promise<Response> {
    const vastModel = VAST_NATIVE_MODELS.find((entry) => entry.id === model);

    if (!vastModel) {
      return Response.json(
        {
          error: {
            message: `Vast model '${model}' not found`,
            type: "invalid_request_error",
            code: "model_not_found",
          },
        },
        { status: 404 },
      );
    }

    return Response.json(vastModel);
  }
}
