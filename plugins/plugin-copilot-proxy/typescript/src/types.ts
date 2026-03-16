import type { LanguageModelUsage } from "ai";

/**
 * Branded type for validated base URL.
 */
export type ValidatedBaseUrl = string & {
  readonly __brand: "ValidatedBaseUrl";
};

/**
 * Branded type for model names.
 */
export type ModelName = string & { readonly __brand: "ModelName" };

/**
 * Model size classification.
 */
export type ModelSize = "small" | "large";

/**
 * Configuration interface for the Copilot Proxy client.
 */
export interface CopilotProxyConfig {
  readonly baseUrl: ValidatedBaseUrl;
  readonly smallModel: ModelName;
  readonly largeModel: ModelName;
  readonly enabled: boolean;
  readonly timeoutSeconds: number;
  readonly maxTokens: number;
  readonly contextWindow: number;
}

/**
 * Parameters for text generation requests.
 */
export interface TextGenerationParams {
  readonly prompt: string;
  readonly stopSequences?: readonly string[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
  readonly topP?: number;
  readonly providerOptions?: ProviderOptions;
}

/**
 * Provider-specific options.
 */
export interface ProviderOptions {
  readonly agentName?: string;
}

/**
 * Parameters for object/JSON generation requests.
 */
export interface ObjectGenerationParams {
  readonly prompt: string;
  readonly schema: JsonSchema;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

/**
 * JSON Schema type definition.
 */
export interface JsonSchema {
  readonly type?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly [key: string]: JsonSchemaValue | undefined;
}

type JsonSchemaValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonSchemaValue[]
  | { readonly [key: string]: JsonSchemaValue | undefined };

/**
 * Union type for extracted JSON responses.
 */
export type ExtractedJSON =
  | JsonObject
  | ReconstructedResponse
  | UnstructuredResponse;

/**
 * Generic JSON object type.
 */
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Generic JSON value type.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Response type when JSON needs reconstruction from partial data.
 */
export interface ReconstructedResponse {
  readonly type: "reconstructed_response";
  readonly thought?: string;
  readonly message?: string;
  readonly codeBlocks?: ReadonlyArray<{
    readonly language: string;
    readonly code: string;
  }>;
}

/**
 * Response type when structured parsing fails.
 */
export interface UnstructuredResponse {
  readonly type: "unstructured_response";
  readonly content: string;
}

/**
 * Token usage statistics.
 */
export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/**
 * Event data for model usage tracking.
 */
export interface ModelUsageEventData {
  readonly provider: "copilot-proxy";
  readonly type: string;
  readonly prompt: string;
  readonly tokens: {
    readonly prompt: number;
    readonly completion: number;
    readonly total: number;
  };
}

/**
 * Result of text generation.
 */
export interface TextGenerationResult {
  readonly text: string;
  readonly usage: LanguageModelUsage | null;
}

/**
 * Telemetry configuration.
 */
export interface TelemetryConfig {
  readonly isEnabled: boolean;
  readonly functionId?: string;
  readonly metadata?: Record<string, string>;
}

/**
 * OpenAI-compatible chat message role.
 */
export type ChatRole = "system" | "user" | "assistant";

/**
 * OpenAI-compatible chat message.
 */
export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

/**
 * OpenAI-compatible chat completion request.
 */
export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly frequency_penalty?: number;
  readonly presence_penalty?: number;
  readonly stop?: readonly string[];
  readonly stream?: boolean;
}

/**
 * OpenAI-compatible chat completion choice.
 */
export interface ChatCompletionChoice {
  readonly index: number;
  readonly message: ChatMessage;
  readonly finish_reason: string | null;
}

/**
 * OpenAI-compatible chat completion response.
 */
export interface ChatCompletionResponse {
  readonly id: string;
  readonly object: string;
  readonly created: number;
  readonly model: string;
  readonly choices: readonly ChatCompletionChoice[];
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

/**
 * Validates and creates a ValidatedBaseUrl.
 */
export function assertValidBaseUrl(
  url: string | undefined,
): asserts url is ValidatedBaseUrl {
  if (!url || url.trim().length === 0) {
    throw new Error(
      "COPILOT_PROXY_BASE_URL is required but not configured. " +
        "Set it in your environment variables or runtime settings.",
    );
  }
  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid base URL: ${url}`);
  }
}

/**
 * Creates a validated base URL from a string.
 */
export function createValidatedBaseUrl(url: string): ValidatedBaseUrl {
  assertValidBaseUrl(url);
  return url as ValidatedBaseUrl;
}

/**
 * Creates a ModelName from a string.
 */
export function createModelName(name: string): ModelName {
  if (!name || name.trim().length === 0) {
    throw new Error("Model name cannot be empty");
  }
  return name as ModelName;
}

/**
 * Type guard for reconstructed response.
 */
export function isReconstructedResponse(
  value: ExtractedJSON,
): value is ReconstructedResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "reconstructed_response"
  );
}

/**
 * Type guard for unstructured response.
 */
export function isUnstructuredResponse(
  value: ExtractedJSON,
): value is UnstructuredResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "unstructured_response"
  );
}
