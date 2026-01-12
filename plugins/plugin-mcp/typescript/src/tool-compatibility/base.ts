import type { IAgentRuntime } from "@elizaos/core";
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

// Model provider detection
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

  public transformToolSchema(toolSchema: JSONSchema7): JSONSchema7 {
    if (!this.shouldApply()) {
      return toolSchema;
    }

    return this.processSchema(toolSchema);
  }

  protected processSchema(schema: JSONSchema7): JSONSchema7 {
    const processed = { ...schema };

    switch (processed.type) {
      case "string":
        return this.processStringSchema(processed);
      case "number":
      case "integer":
        return this.processNumberSchema(processed);
      case "array":
        return this.processArraySchema(processed);
      case "object":
        return this.processObjectSchema(processed);
      default:
        return this.processGenericSchema(processed);
    }
  }

  protected processStringSchema(schema: JSONSchema7): JSONSchema7 {
    const constraints: StringConstraints = {};
    const processed: Record<string, unknown> = { ...schema };

    if (typeof schema.minLength === "number") {
      constraints.minLength = schema.minLength;
    }
    if (typeof schema.maxLength === "number") {
      constraints.maxLength = schema.maxLength;
    }
    if (typeof schema.pattern === "string") {
      constraints.pattern = schema.pattern;
    }
    if (typeof schema.format === "string") {
      constraints.format = schema.format;
    }
    if (Array.isArray(schema.enum)) {
      constraints.enum = schema.enum as string[];
    }

    const unsupportedProps = this.getUnsupportedStringProperties();
    for (const prop of unsupportedProps) {
      if (prop in processed) {
        delete processed[prop];
      }
    }

    if (Object.keys(constraints).length > 0) {
      processed.description = this.mergeDescription(schema.description, constraints);
    }

    return processed as JSONSchema7;
  }

  protected processNumberSchema(schema: JSONSchema7): JSONSchema7 {
    const constraints: NumberConstraints = {};
    const processed: Record<string, unknown> = { ...schema };

    if (typeof schema.minimum === "number") {
      constraints.minimum = schema.minimum;
    }
    if (typeof schema.maximum === "number") {
      constraints.maximum = schema.maximum;
    }
    if (typeof schema.exclusiveMinimum === "number") {
      constraints.exclusiveMinimum = schema.exclusiveMinimum;
    }
    if (typeof schema.exclusiveMaximum === "number") {
      constraints.exclusiveMaximum = schema.exclusiveMaximum;
    }
    if (typeof schema.multipleOf === "number") {
      constraints.multipleOf = schema.multipleOf;
    }

    const unsupportedProps = this.getUnsupportedNumberProperties();
    for (const prop of unsupportedProps) {
      if (prop in processed) {
        delete processed[prop];
      }
    }

    if (Object.keys(constraints).length > 0) {
      processed.description = this.mergeDescription(schema.description, constraints);
    }

    return processed as JSONSchema7;
  }

  protected processArraySchema(schema: JSONSchema7): JSONSchema7 {
    const constraints: ArrayConstraints = {};
    const processed: Record<string, unknown> = { ...schema };

    if (typeof schema.minItems === "number") {
      constraints.minItems = schema.minItems;
    }
    if (typeof schema.maxItems === "number") {
      constraints.maxItems = schema.maxItems;
    }
    if (typeof schema.uniqueItems === "boolean") {
      constraints.uniqueItems = schema.uniqueItems;
    }

    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      processed.items = this.processSchema(schema.items as JSONSchema7);
    }

    const unsupportedProps = this.getUnsupportedArrayProperties();
    for (const prop of unsupportedProps) {
      if (prop in processed) {
        delete processed[prop];
      }
    }

    if (Object.keys(constraints).length > 0) {
      processed.description = this.mergeDescription(schema.description, constraints);
    }

    return processed as JSONSchema7;
  }

  protected processObjectSchema(schema: JSONSchema7): JSONSchema7 {
    const constraints: ObjectConstraints = {};
    const processed: Record<string, unknown> = { ...schema };

    if (typeof schema.minProperties === "number") {
      constraints.minProperties = schema.minProperties;
    }
    if (typeof schema.maxProperties === "number") {
      constraints.maxProperties = schema.maxProperties;
    }
    if (typeof schema.additionalProperties === "boolean") {
      constraints.additionalProperties = schema.additionalProperties;
    }

    if (schema.properties && typeof schema.properties === "object") {
      const newProperties: Record<string, JSONSchema7> = {};
      for (const [key, prop] of Object.entries(schema.properties)) {
        if (typeof prop === "object" && !Array.isArray(prop)) {
          newProperties[key] = this.processSchema(prop as JSONSchema7);
        } else {
          newProperties[key] = prop as JSONSchema7;
        }
      }
      processed.properties = newProperties;
    }

    const unsupportedProps = this.getUnsupportedObjectProperties();
    for (const prop of unsupportedProps) {
      if (prop in processed) {
        delete processed[prop];
      }
    }

    if (Object.keys(constraints).length > 0) {
      processed.description = this.mergeDescription(schema.description, constraints);
    }

    return processed as JSONSchema7;
  }

  protected processGenericSchema(schema: JSONSchema7): JSONSchema7 {
    const processed: Record<string, unknown> = { ...schema };

    if (Array.isArray(schema.oneOf)) {
      processed.oneOf = schema.oneOf.map((s) =>
        typeof s === "object" ? this.processSchema(s as JSONSchema7) : s
      );
    }
    if (Array.isArray(schema.anyOf)) {
      processed.anyOf = schema.anyOf.map((s) =>
        typeof s === "object" ? this.processSchema(s as JSONSchema7) : s
      );
    }
    if (Array.isArray(schema.allOf)) {
      processed.allOf = schema.allOf.map((s) =>
        typeof s === "object" ? this.processSchema(s as JSONSchema7) : s
      );
    }

    return processed as JSONSchema7;
  }

  protected mergeDescription(
    originalDescription: string | undefined,
    constraints: SchemaConstraints
  ): string {
    const constraintJson = JSON.stringify(constraints);
    if (originalDescription) {
      return `${originalDescription}\n${constraintJson}`;
    }
    return constraintJson;
  }

  protected abstract getUnsupportedStringProperties(): readonly string[];
  protected abstract getUnsupportedNumberProperties(): readonly string[];
  protected abstract getUnsupportedArrayProperties(): readonly string[];
  protected abstract getUnsupportedObjectProperties(): readonly string[];
}

interface RuntimeWithModel extends IAgentRuntime {
  modelProvider?: string;
  model?: string;
}

function hasModelInfo(runtime: IAgentRuntime): runtime is RuntimeWithModel {
  return (
    typeof runtime === "object" &&
    runtime !== null &&
    ("modelProvider" in runtime || "model" in runtime)
  );
}

function getModelString(runtime: IAgentRuntime): string {
  if (hasModelInfo(runtime)) {
    return runtime.modelProvider ?? runtime.model ?? "";
  }
  if (
    runtime.character &&
    typeof runtime.character === "object" &&
    "settings" in runtime.character &&
    runtime.character.settings &&
    typeof runtime.character.settings === "object"
  ) {
    const settings = runtime.character.settings as Record<string, unknown>;
    const modelProvider = settings.MODEL_PROVIDER ?? settings.modelProvider;
    const model = settings.MODEL ?? settings.model;
    return String(modelProvider ?? model ?? "");
  }
  return "";
}

export function detectModelProvider(runtime: IAgentRuntime): ModelInfo {
  const modelString = getModelString(runtime);
  const modelId = String(modelString).toLowerCase();

  let provider: ModelProvider = "openrouter";
  let supportsStructuredOutputs = false;
  let isReasoningModel = false;

  if (
    modelId.includes("openai") ||
    modelId.includes("gpt-") ||
    modelId.includes("o1-") ||
    modelId.includes("o3-")
  ) {
    provider = "openai";
    supportsStructuredOutputs =
      modelId.includes("gpt-4") || modelId.includes("o1") || modelId.includes("o3");
    isReasoningModel = modelId.includes("o1") || modelId.includes("o3");
  } else if (modelId.includes("anthropic") || modelId.includes("claude")) {
    provider = "anthropic";
    supportsStructuredOutputs = true;
  } else if (modelId.includes("google") || modelId.includes("gemini")) {
    provider = "google";
    supportsStructuredOutputs = true;
  } else if (modelId.includes("openrouter")) {
    provider = "openrouter";
    supportsStructuredOutputs = false;
  }

  return {
    provider,
    modelId,
    supportsStructuredOutputs,
    isReasoningModel,
  };
}
