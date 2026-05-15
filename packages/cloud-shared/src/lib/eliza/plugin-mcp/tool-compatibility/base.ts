import type { JSONSchema7, JSONSchema7Definition } from "json-schema";

export type ModelProvider = "openai" | "anthropic" | "google" | "openrouter" | "unknown";

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
    return this.shouldApply() ? (this.processSchema(toolSchema) as TSchema) : toolSchema;
  }

  protected processSchema(schema: JSONSchema7): JSONSchema7 {
    const processed = { ...schema };

    switch (processed.type) {
      case "string":
        return this.processTypeSchema(processed, this.getUnsupportedStringProperties());
      case "number":
      case "integer":
        return this.processTypeSchema(processed, this.getUnsupportedNumberProperties());
      case "array":
        return this.processArraySchema(processed);
      case "object":
        return this.processObjectSchema(processed);
      default:
        return this.processGenericSchema(processed);
    }
  }

  protected processTypeSchema(schema: JSONSchema7, unsupported: string[]): JSONSchema7 {
    const processed = { ...schema };
    const constraints: Record<string, unknown> = {};

    // Extract all constraint properties
    for (const prop of [
      "minLength",
      "maxLength",
      "pattern",
      "format",
      "enum",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "minItems",
      "maxItems",
      "uniqueItems",
    ]) {
      if (schema[prop as keyof JSONSchema7] !== undefined) {
        constraints[prop] = schema[prop as keyof JSONSchema7];
      }
    }

    for (const prop of unsupported) {
      delete (processed as Record<string, unknown>)[prop];
    }

    if (Object.keys(constraints).length > 0) {
      processed.description = this.mergeDescription(schema.description, constraints);
    }

    return processed;
  }

  protected processArraySchema(schema: JSONSchema7): JSONSchema7 {
    const processed = this.processTypeSchema(schema, this.getUnsupportedArrayProperties());

    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      processed.items = this.processSchema(schema.items as JSONSchema7);
    }

    return processed;
  }

  protected processObjectSchema(schema: JSONSchema7): JSONSchema7 {
    const processed = this.processTypeSchema(schema, this.getUnsupportedObjectProperties());

    if (schema.properties) {
      processed.properties = {};
      for (const [key, prop] of Object.entries(schema.properties)) {
        processed.properties[key] =
          typeof prop === "object" && !Array.isArray(prop)
            ? this.processSchema(prop as JSONSchema7)
            : prop;
      }
    }

    return processed;
  }

  protected processGenericSchema(schema: JSONSchema7): JSONSchema7 {
    const processed = { ...schema };

    for (const key of ["oneOf", "anyOf", "allOf"] as const) {
      const variants = schema[key];
      if (Array.isArray(variants)) {
        processed[key] = variants.map((subschema: JSONSchema7Definition) =>
          typeof subschema === "object" ? this.processSchema(subschema) : subschema,
        );
      }
    }

    return processed;
  }

  protected mergeDescription(
    original: string | undefined,
    constraints: Record<string, unknown>,
  ): string {
    const json = JSON.stringify(constraints);
    return original ? `${original}\n${json}` : json;
  }

  protected abstract getUnsupportedStringProperties(): string[];
  protected abstract getUnsupportedNumberProperties(): string[];
  protected abstract getUnsupportedArrayProperties(): string[];
  protected abstract getUnsupportedObjectProperties(): string[];
}
