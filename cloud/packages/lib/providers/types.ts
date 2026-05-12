/**
 * Type definitions for AI provider interfaces.
 */

import type { CloudMergedProviderOptions } from "@/lib/providers/cloud-provider-options";

/**
 * OpenAI-compatible chat message.
 */
export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content:
    | string
    | Array<{
        type: string;
        text?: string;
        image_url?: { url: string } | string;
        file?: { filename?: string; file_data?: string; file_id?: string };
      }>;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/**
 * OpenAI Chat Completions tool definition (nested form).
 *
 * The Responses API uses a flat shape `{type, name, parameters}`; the
 * Chat Completions API uses this nested shape. The `/v1/responses` route
 * normalizes flat tools to this shape before forwarding downstream.
 */
export interface ChatCompletionsTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * OpenAI Chat Completions tool_choice (nested form).
 */
export type ChatCompletionsToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

/**
 * OpenAI-compatible chat completion request.
 */
export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
  stop?: string | string[];
  n?: number;
  user?: string;
  tools?: ChatCompletionsTool[];
  tool_choice?: ChatCompletionsToolChoice;
  response_format?:
    | { type: "json_object" | "text" }
    | {
        type: "json_schema";
        json_schema: {
          name?: string;
          description?: string;
          schema?: Record<string, unknown>;
          strict?: boolean;
        };
      };
  seed?: number;
  logprobs?: boolean;
  top_logprobs?: number;
  /** OpenAI-compatible cache routing hint used by Cerebras-compatible providers. */
  prompt_cache_key?: string;
  /** Provider-specific options (matches AI SDK `SharedV3ProviderOptions`). */
  providerOptions?: CloudMergedProviderOptions;
}

export interface ProviderRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * OpenAI-compatible chat completion response.
 */
export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * OpenAI-compatible embeddings request.
 */
export interface OpenAIEmbeddingsRequest {
  input: string | string[];
  model: string;
  encoding_format?: "float" | "base64";
  dimensions?: number;
  user?: string;
}

/**
 * OpenAI-compatible embeddings response.
 */
export interface OpenAIEmbeddingsResponse {
  object: "list";
  data: Array<{
    object: "embedding";
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI-compatible model information.
 */
export interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  released?: number;
  name?: string;
  description?: string;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  context_length?: number;
  context_window?: number;
  max_tokens?: number;
  type?: string;
  tags?: string[];
  pricing?: Record<string, unknown>;
  recommended?: boolean;
  free?: boolean;
}

/**
 * OpenAI-compatible models list response.
 */
export interface OpenAIModelsResponse {
  object: "list";
  data: OpenAIModel[];
}

/**
 * Structured error envelope thrown by every direct HTTP provider
 * (OpenRouter, OpenAI direct, Anthropic direct, Groq) when the upstream
 * call fails, times out, or is aborted. The failover layer matches on
 * `status` to decide retryability; routes surface `error.message` to
 * callers verbatim.
 */
export interface ProviderHttpError {
  status: number;
  error: {
    message: string;
    type?: string;
    code?: string;
  };
}

/**
 * Interface for AI provider implementations.
 */
export interface AIProvider {
  name: string;
  chatCompletions(request: OpenAIChatRequest, options?: ProviderRequestOptions): Promise<Response>;
  embeddings(request: OpenAIEmbeddingsRequest): Promise<Response>;
  listModels(): Promise<Response>;
  getModel(model: string): Promise<Response>;
}
