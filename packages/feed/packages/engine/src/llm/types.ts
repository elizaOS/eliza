/**
 * Shared LLM types used across the engine.
 *
 * These types are intentionally provider-agnostic and avoid depending on any
 * specific client implementation (e.g. OpenAI SDK).
 */

/** Minimal JSON schema shape used for structured generation validation. */
export interface LLMJsonSchema {
  required?: string[];
  properties?: Record<string, LLMJsonSchemaProperty>;
}

export interface LLMJsonSchemaProperty {
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  items?: LLMJsonSchemaProperty;
  properties?: Record<string, LLMJsonSchemaProperty>;
}

export interface LLMGenerateJSONOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  format?: 'xml' | 'json';
  /** Prompt type identifier for logging and monitoring */
  promptType?: string;
  /** Prompt template for logging and monitoring */
  promptTemplate?: string;
}

/**
 * Minimal interface for any LLM client used by engine services.
 * Matches `BabylonLLMClient.generateJSON`.
 */
export interface LLMJsonClient {
  generateJSON<T>(
    prompt: string,
    schema?: LLMJsonSchema,
    options?: LLMGenerateJSONOptions
  ): Promise<T>;
}
