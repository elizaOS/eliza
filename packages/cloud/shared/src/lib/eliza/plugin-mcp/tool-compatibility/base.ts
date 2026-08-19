// Wires hosted Eliza agent base behavior for cloud runtime services.
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";

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
      "minProperties",
      "maxProperties",
    ]) {
      if (schema[prop as keyof JSONSchema7] !== undefined) {
        constraints[prop] = schema[prop as keyof JSONSchema7];
      }
    }

    // `additionalProperties` is useful diagnostic input only when this
    // provider strips it. Collecting it for providers that preserve the
    // keyword duplicates every closed-object schema in model-facing prose.
    if (unsupported.includes("additionalProperties") && schema.additionalProperties !== undefined) {
      constraints.additionalProperties = schema.additionalProperties;
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
    const json = this.stringifyConstraints(constraints);
    return original ? `${original}\n${json}` : json;
  }

  /** Preserve invalid JavaScript-only numbers instead of JSON-coercing them to null. */
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
