/**
 * Local MCP compatibility facade: model metadata and provider-specific prose
 * stay public here while schema traversal and budgets live in the shared kernel.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { detectMcpModelProvider, transformMcpToolSchema } from "@elizaos/shared/mcp";
import type { JSONSchema7 } from "json-schema";

export interface StringConstraints {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  enum?: readonly string[];
}
export interface NumberConstraints {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
}
export interface ArrayConstraints {
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}
export interface ObjectConstraints {
  minProperties?: number;
  maxProperties?: number;
  additionalProperties?: boolean;
}
export type SchemaConstraints =
  | StringConstraints
  | NumberConstraints
  | ArrayConstraints
  | ObjectConstraints;
export type ModelProvider = "openai" | "anthropic" | "google" | "openrouter";
export interface ModelInfo {
  readonly provider: ModelProvider;
  readonly modelId: string;
  readonly supportsStructuredOutputs?: boolean;
  readonly isReasoningModel?: boolean;
}

export abstract class McpToolCompatibility {
  protected readonly modelInfo: ModelInfo;

  constructor(modelInfo: ModelInfo) {
    this.modelInfo = modelInfo;
  }

  abstract shouldApply(): boolean;

  transformToolSchema(toolSchema: JSONSchema7): JSONSchema7 {
    return transformMcpToolSchema(toolSchema as Record<string, unknown>, {
      applies: this.shouldApply(),
      unsupportedFor: (type) => this.unsupportedFor(type),
      describe: (original, constraints) =>
        this.mergeDescription(original, constraints as SchemaConstraints),
    }) as JSONSchema7;
  }

  private unsupportedFor(type: string | undefined): readonly string[] {
    switch (type) {
      case "string":
        return this.getUnsupportedStringProperties();
      case "number":
      case "integer":
        return this.getUnsupportedNumberProperties();
      case "array":
        return this.getUnsupportedArrayProperties();
      case "object":
        return this.getUnsupportedObjectProperties();
      default:
        return [];
    }
  }

  protected mergeDescription(original: string | undefined, constraints: SchemaConstraints): string {
    const serialized = JSON.stringify(constraints);
    return original ? `${original}\n${serialized}` : serialized;
  }

  protected abstract getUnsupportedStringProperties(): readonly string[];
  protected abstract getUnsupportedNumberProperties(): readonly string[];
  protected abstract getUnsupportedArrayProperties(): readonly string[];
  protected abstract getUnsupportedObjectProperties(): readonly string[];
}

export function detectModelProvider(runtime: IAgentRuntime): ModelInfo {
  const detected = detectMcpModelProvider(runtime);
  return {
    ...detected,
    // The local facade has historically treated unrecognized and pass-through
    // routers as OpenRouter so callers never receive a provider outside its
    // public ModelProvider union.
    provider:
      detected.provider === "unknown" || detected.provider === "bitrouter"
        ? "openrouter"
        : detected.provider,
  };
}
