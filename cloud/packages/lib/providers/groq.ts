import { GROQ_NATIVE_MODELS, getGroqApiModelId } from "@/lib/models";
import { logger } from "@/lib/utils/logger";
import type {
  AIProvider,
  OpenAIChatRequest,
  OpenAIEmbeddingsRequest,
  ProviderRequestOptions,
} from "./types";

interface GroqError {
  error: {
    message: string;
    type?: string;
    code?: string;
  };
}

export class GroqProvider implements AIProvider {
  name = "groq";
  private baseUrl = "https://api.groq.com/openai/v1";
  private apiKey: string;
  private timeout = 2 * 60000;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("Groq API key is required");
    }
    this.apiKey = apiKey;
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number = this.timeout,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal =
      options.signal && timeoutSignal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : (options.signal ?? timeoutSignal);

    try {
      const response = await fetch(url, {
        ...options,
        signal,
      });

      if (!response.ok) {
        let errorData: GroqError | null = null;

        try {
          const text = await response.text();
          errorData = JSON.parse(text);
        } catch {
          // Fall through to the generic error below.
        }

        throw {
          status: response.status,
          error: errorData?.error || {
            message: `Groq request failed with status ${response.status}`,
            type: "groq_error",
            code: "groq_request_failed",
          },
        };
      }

      return response;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (timeoutSignal.aborted) {
          throw {
            status: 504,
            error: {
              message: `Groq request timeout after ${Math.floor(timeoutMs / 1000)} seconds`,
              type: "timeout_error",
              code: "groq_timeout",
            },
          };
        }

        if (options.signal?.aborted) {
          throw {
            status: 499,
            error: {
              message: "Groq request aborted",
              type: "abort_error",
              code: "request_aborted",
            },
          };
        }

        throw {
          status: 504,
          error: {
            message: `Groq request timeout after ${Math.floor(timeoutMs / 1000)} seconds`,
            type: "timeout_error",
            code: "groq_timeout",
          },
        };
      }

      throw error;
    }
  }

  async chatCompletions(
    request: OpenAIChatRequest,
    options?: ProviderRequestOptions,
  ): Promise<Response> {
    const { providerOptions: _providerOptions, ...rest } = request;
    const groqRequest: OpenAIChatRequest = {
      ...rest,
      model: getGroqApiModelId(request.model),
    };

    logger.debug("[Groq] Forwarding chat completion request", {
      model: request.model,
      resolvedModel: groqRequest.model,
      streaming: request.stream,
      messageCount: request.messages.length,
    });

    return this.fetchWithTimeout(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(groqRequest),
        signal: options?.signal,
      },
      options?.timeoutMs,
    );
  }

  async embeddings(_request: OpenAIEmbeddingsRequest): Promise<Response> {
    return Response.json(
      {
        error: {
          message: "Groq embeddings are not supported by this provider adapter",
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
      data: GROQ_NATIVE_MODELS,
    });
  }

  async getModel(model: string): Promise<Response> {
    const groqModel = GROQ_NATIVE_MODELS.find((entry) => entry.id === model);

    if (!groqModel) {
      return Response.json(
        {
          error: {
            message: `Groq model '${model}' not found`,
            type: "invalid_request_error",
            code: "model_not_found",
          },
        },
        { status: 404 },
      );
    }

    return Response.json(groqModel);
  }
}
