/**
 * Type definitions for AI provider interfaces.
 */

/**
 * OpenAI-compatible chat message.
 */
export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content:
    | string
    | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

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
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  tool_choice?:
    | "auto"
    | "none"
    | { type: "function"; function: { name: string } };
  response_format?: { type: "json_object" | "text" };
  seed?: number;
  logprobs?: boolean;
  top_logprobs?: number;
  providerOptions?: {
    gateway?: {
      order?: string[];
    };
  };
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
}

/**
 * OpenAI-compatible models list response.
 */
export interface OpenAIModelsResponse {
  object: "list";
  data: OpenAIModel[];
}

/**
 * Interface for AI provider implementations.
 */
export interface AIProvider {
  name: string;
  chatCompletions(request: OpenAIChatRequest): Promise<Response>;
  embeddings(request: OpenAIEmbeddingsRequest): Promise<Response>;
  listModels(): Promise<Response>;
  getModel(model: string): Promise<Response>;
}
