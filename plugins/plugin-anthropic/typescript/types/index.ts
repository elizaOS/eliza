import type { LanguageModelUsage } from "ai";

export type ValidatedApiKey = string & { readonly __brand: "ValidatedApiKey" };

export type ModelName = string & { readonly __brand: "ModelName" };

export type ModelSize = "small" | "large";

export interface AnthropicConfig {
  readonly apiKey: ValidatedApiKey;
  readonly smallModel: ModelName;
  readonly largeModel: ModelName;
  readonly baseUrl: string;
  readonly browserBaseUrl: string | null;
  readonly experimentalTelemetry: boolean;
  readonly cotBudget: number;
  readonly cotBudgetSmall: number;
  readonly cotBudgetLarge: number;
}

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

export interface ProviderOptions {
  readonly agentName?: string;
  readonly anthropic?: AnthropicProviderOptions;
}

export interface AnthropicProviderOptions {
  readonly thinking?: {
    readonly type: "enabled";
    readonly budgetTokens: number;
  };
}

export interface ObjectGenerationParams {
  readonly prompt: string;
  readonly schema: JsonSchema;
  readonly temperature?: number;
}

interface JsonSchemaFact {
  readonly name: string;
  readonly type: string;
}

interface JsonSchemaRelationship {
  readonly name: string;
  readonly type: string;
}

type JsonSchemaValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonSchemaValue[]
  | readonly JsonSchemaFact[]
  | readonly JsonSchemaRelationship[]
  | { readonly [key: string]: JsonSchemaValue | undefined };

export interface JsonSchema {
  readonly type?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly facts?: readonly JsonSchemaFact[];
  readonly relationships?: readonly JsonSchemaRelationship[];
  readonly [key: string]: JsonSchemaValue | undefined;
}

export type ExtractedJSON =
  | JsonObject
  | ReconstructedResponse
  | ReflectionResponse
  | UnstructuredResponse;

export type JsonObject = { readonly [key: string]: JsonValue };

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface CodeBlockPlaceholder {
  readonly placeholder: string;
  readonly content: string;
}

export interface ReconstructedResponse {
  readonly type: "reconstructed_response";
  readonly thought?: string;
  readonly message?: string;
  readonly codeBlocks?: ReadonlyArray<{
    readonly language: string;
    readonly code: string;
  }>;
}

export interface ReflectionResponse {
  readonly thought: string;
  readonly facts: readonly JsonValue[];
  readonly relationships: readonly JsonValue[];
  readonly rawContent: string;
}

export interface UnstructuredResponse {
  readonly type: "unstructured_response";
  readonly content: string;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ModelUsageEventData {
  readonly provider: "anthropic";
  readonly type: string;
  readonly prompt: string;
  readonly tokens: {
    readonly prompt: number;
    readonly completion: number;
    readonly total: number;
  };
}

export interface TextGenerationResult {
  readonly text: string;
  readonly usage: LanguageModelUsage | null;
}

export interface TelemetryConfig {
  readonly isEnabled: boolean;
  readonly functionId?: string;
  readonly metadata?: Record<string, string>;
}

export function assertValidApiKey(apiKey: string | undefined): asserts apiKey is ValidatedApiKey {
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      "ANTHROPIC_API_KEY is required but not configured. " +
        "Set it in your environment variables or runtime settings."
    );
  }
}

export function createModelName(name: string): ModelName {
  if (!name || name.trim().length === 0) {
    throw new Error("Model name cannot be empty");
  }
  return name as ModelName;
}

export function isReconstructedResponse(value: ExtractedJSON): value is ReconstructedResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "reconstructed_response"
  );
}

export function isReflectionResponse(value: ExtractedJSON): value is ReflectionResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "thought" in value &&
    "facts" in value &&
    "relationships" in value &&
    "rawContent" in value
  );
}

export function isUnstructuredResponse(value: ExtractedJSON): value is UnstructuredResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "unstructured_response"
  );
}

export function isReflectionSchema(schema: JsonSchema | undefined): boolean {
  return !!(schema && "facts" in schema && "relationships" in schema);
}
