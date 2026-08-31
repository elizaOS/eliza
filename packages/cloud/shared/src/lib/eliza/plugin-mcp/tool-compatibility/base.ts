/**
 * Cloud MCP compatibility facade over the shared schema traversal kernel;
 * malformed-schema diagnostics remain Cloud policy while transports stay out.
 */

import { transformMcpToolSchema } from "@elizaos/shared/mcp";
import type { JSONSchema7 } from "json-schema";

export type ModelProvider = "openai" | "anthropic" | "google" | "bitrouter" | "unknown";
export interface ModelInfo {
  provider: ModelProvider;
  modelId: string;
  supportsStructuredOutputs?: boolean;
  isReasoningModel?: boolean;
}

export abstract class McpToolCompatibility {
  protected modelInfo: ModelInfo;

  constructor(modelInfo: ModelInfo) {
    this.modelInfo = modelInfo;
  }

  abstract shouldApply(): boolean;

  transformToolSchema<TSchema extends JSONSchema7>(toolSchema: TSchema): TSchema {
    return transformMcpToolSchema(toolSchema as Record<string, unknown>, {
      applies: this.shouldApply(),
      enforceBudget: false,
      unsupportedFor: (type) => this.unsupportedFor(type),
      describe: (original, constraints) => this.mergeDescription(original, { ...constraints }),
    }) as TSchema;
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

  protected mergeDescription(
    original: string | undefined,
    constraints: Record<string, unknown>,
  ): string {
    const serialized = this.stringifyConstraints(constraints);
    return original ? `${original}\n${serialized}` : serialized;
  }

  protected stringifyConstraints(constraints: Record<string, unknown>): string {
    return JSON.stringify(constraints, (_key, value) =>
      typeof value === "number" && !Number.isFinite(value)
        ? `[non-finite number: ${String(value)}]`
        : value,
    );
  }

  protected abstract getUnsupportedStringProperties(): string[];
  protected abstract getUnsupportedNumberProperties(): string[];
  protected abstract getUnsupportedArrayProperties(): string[];
  protected abstract getUnsupportedObjectProperties(): string[];
}
