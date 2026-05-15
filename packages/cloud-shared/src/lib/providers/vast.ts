/**
 * Vast.ai Serverless provider.
 *
 * Forwards OpenAI-compatible chat completions to a Vast Serverless endpoint
 * fronted by vLLM or llama.cpp via PyWorker. The endpoint URL and auth token
 * are resolved per model by the provider factory so 2B/9B/27B can be deployed,
 * scaled, and failed over independently.
 *
 * Catalog ids look like `vast/eliza-1-27b`. Optimized vLLM endpoints are served
 * under names like `eliza-1-27b`, while older llama.cpp endpoints may use the
 * catalog id directly. The resolved endpoint config decides what model id to
 * send upstream.
 *
 * Eliza structure-forcing fields (prefillPlan, guidedDecode, plannerActionSchemas)
 * are forwarded from providerOptions.eliza as top-level eliza_* keys so the
 * worker's dflash-enabled llama-server can apply them without code changes.
 */

import { getVastApiModelId, VAST_NATIVE_MODELS } from "../models";
import { logger } from "../utils/logger";
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

/**
 * Convert camelCase key to snake_case.
 * Example: prefillPlan -> prefill_plan
 */
function toSnakeCase(str: string): string {
  return str.replace(/([A-Z])/g, "_$1").toLowerCase();
}

/**
 * Forward eliza-specific providerOptions fields as top-level keys.
 * Known fields: prefillPlan, guidedDecode, plannerActionSchemas.
 * The dflash-enabled llama-server on Vast workers expects these as top-level
 * eliza_* fields in the request body.
 */
function extractElizaFields(
  providerOptions: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!providerOptions?.eliza || typeof providerOptions.eliza !== "object") {
    return {};
  }

  const elizaOptions = providerOptions.eliza as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  // Known eliza fields that should be forwarded to the worker
  const knownFields = ["prefillPlan", "guidedDecode", "plannerActionSchemas"];

  for (const key of knownFields) {
    if (key in elizaOptions && elizaOptions[key] !== undefined) {
      const snakeKey = `eliza_${toSnakeCase(key)}`;
      result[snakeKey] = elizaOptions[key];
    }
  }

  return result;
}

export class VastProvider implements AIProvider {
  name = "vast";
  private baseUrl: string;
  private apiKey: string;
  private apiModelId?: string;
  private timeout = 2 * 60000;

  constructor(apiKey: string, baseUrl: string, options?: { apiModelId?: string }) {
    if (!apiKey) {
      throw new Error("Vast API key is required");
    }
    if (!baseUrl) {
      throw new Error("Vast base URL is required");
    }
    this.apiKey = apiKey;
    this.baseUrl = trimTrailingSlash(baseUrl);
    this.apiModelId = options?.apiModelId;
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
    const { providerOptions, ...rest } = request;
    const body = {
      ...rest,
      model: this.apiModelId ?? getVastApiModelId(rest.model),
      // Forward eliza fields from providerOptions as top-level keys
      ...extractElizaFields(providerOptions),
    };

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
