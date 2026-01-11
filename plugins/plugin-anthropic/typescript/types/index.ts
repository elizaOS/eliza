/**
 * Core types for the Anthropic plugin.
 *
 * These types are strongly typed with no `any` or `unknown` where avoidable.
 */

import type { LanguageModelUsage } from "ai";

/**
 * Validated API key - a non-empty string.
 * This is a branded type to ensure we never pass an unvalidated string.
 */
export type ValidatedApiKey = string & { readonly __brand: "ValidatedApiKey" };

/**
 * Validated model name - a non-empty string representing an Anthropic model.
 */
export type ModelName = string & { readonly __brand: "ModelName" };

/**
 * Anthropic model size for CoT budget selection
 */
export type ModelSize = "small" | "large";

/**
 * Configuration settings for the Anthropic plugin
 */
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

/**
 * Parameters for text generation
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
 * Provider-specific options passed to the AI SDK
 */
export interface ProviderOptions {
  readonly agentName?: string;
  readonly anthropic?: AnthropicProviderOptions;
}

/**
 * Anthropic-specific provider options
 */
export interface AnthropicProviderOptions {
  readonly thinking?: {
    readonly type: "enabled";
    readonly budgetTokens: number;
  };
}

/**
 * Parameters for object/JSON generation
 */
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

/**
 * A JSON Schema definition
 */
export interface JsonSchema {
  readonly type?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly facts?: readonly JsonSchemaFact[];
  readonly relationships?: readonly JsonSchemaRelationship[];
  readonly [key: string]: JsonSchemaValue | undefined;
}

/**
 * Result of extracting JSON from LLM response
 */
export type ExtractedJSON =
  | JsonObject
  | ReconstructedResponse
  | ReflectionResponse
  | UnstructuredResponse;

/**
 * A parsed JSON object with string keys
 */
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Valid JSON value types
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * A placeholder for code blocks during JSON extraction
 */
export interface CodeBlockPlaceholder {
  readonly placeholder: string;
  readonly content: string;
}

/**
 * Reconstructed response when JSON is extracted from mixed content
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
 * Reflection schema response with thought, facts, and relationships
 */
export interface ReflectionResponse {
  readonly thought: string;
  readonly facts: readonly JsonValue[];
  readonly relationships: readonly JsonValue[];
  readonly rawContent: string;
}

/**
 * Fallback response when JSON cannot be extracted
 */
export interface UnstructuredResponse {
  readonly type: "unstructured_response";
  readonly content: string;
}

/**
 * Token usage information from model response
 */
export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/**
 * Model usage event data
 */
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

/**
 * Result from text generation
 */
export interface TextGenerationResult {
  readonly text: string;
  readonly usage: LanguageModelUsage | null;
}

/**
 * Telemetry configuration for AI SDK
 */
export interface TelemetryConfig {
  readonly isEnabled: boolean;
  readonly functionId?: string;
  readonly metadata?: Record<string, string>;
}

/**
 * Assertion function to validate API key
 * @throws Error if apiKey is falsy or empty
 */
export function assertValidApiKey(apiKey: string | undefined): asserts apiKey is ValidatedApiKey {
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      "ANTHROPIC_API_KEY is required but not configured. " +
        "Set it in your environment variables or runtime settings."
    );
  }
}

/**
 * Create a validated model name
 */
export function createModelName(name: string): ModelName {
  if (!name || name.trim().length === 0) {
    throw new Error("Model name cannot be empty");
  }
  return name as ModelName;
}

/**
 * Type guard for ReconstructedResponse
 */
export function isReconstructedResponse(value: ExtractedJSON): value is ReconstructedResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "reconstructed_response"
  );
}

/**
 * Type guard for ReflectionResponse
 */
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

/**
 * Type guard for UnstructuredResponse
 */
export function isUnstructuredResponse(value: ExtractedJSON): value is UnstructuredResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "unstructured_response"
  );
}

/**
 * Check if a schema is a reflection schema (has facts and relationships)
 */
export function isReflectionSchema(schema: JsonSchema | undefined): boolean {
  return !!(schema && "facts" in schema && "relationships" in schema);
}
