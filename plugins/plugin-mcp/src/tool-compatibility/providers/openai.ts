/**
 * OpenAI MCP tool-schema fixup: strips keywords older or reasoning OpenAI models
 * reject (format, and more for reasoning models), applied only when the model
 * lacks structured-output support or is a reasoning model. The reasoning-model
 * variant additionally folds the dropped constraints into an IMPORTANT note in
 * the description.
 */
import { McpToolCompatibility, type SchemaConstraints } from "../base";

interface OpenAIConstraints {
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  format?: string;
  pattern?: string;
  enum?: readonly string[];
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
  additionalProperties?: boolean;
}

export class OpenAIMcpCompatibility extends McpToolCompatibility {
  shouldApply(): boolean {
    return (
      this.modelInfo.provider === "openai" &&
      (!this.modelInfo.supportsStructuredOutputs || this.modelInfo.isReasoningModel === true)
    );
  }

  protected getUnsupportedStringProperties(): readonly string[] {
    const baseUnsupported = ["format"];

    if (this.modelInfo.isReasoningModel === true) {
      return [...baseUnsupported, "pattern"];
    }

    if (this.modelInfo.modelId.includes("gpt-3.5") || this.modelInfo.modelId.includes("davinci")) {
      return [...baseUnsupported, "pattern"];
    }

    return baseUnsupported;
  }

  protected getUnsupportedNumberProperties(): readonly string[] {
    if (this.modelInfo.isReasoningModel === true) {
      return ["exclusiveMinimum", "exclusiveMaximum", "multipleOf"];
    }
    return [];
  }

  protected getUnsupportedArrayProperties(): readonly string[] {
    if (this.modelInfo.isReasoningModel === true) {
      return ["uniqueItems"];
    }
    return [];
  }

  protected getUnsupportedObjectProperties(): readonly string[] {
    return ["minProperties", "maxProperties"];
  }
}

export class OpenAIReasoningMcpCompatibility extends McpToolCompatibility {
  shouldApply(): boolean {
    return this.modelInfo.provider === "openai" && this.modelInfo.isReasoningModel === true;
  }

  protected getUnsupportedStringProperties(): readonly string[] {
    return ["format", "pattern", "minLength", "maxLength"];
  }

  protected getUnsupportedNumberProperties(): readonly string[] {
    return ["exclusiveMinimum", "exclusiveMaximum", "multipleOf"];
  }

  protected getUnsupportedArrayProperties(): readonly string[] {
    return ["uniqueItems", "minItems", "maxItems"];
  }

  protected getUnsupportedObjectProperties(): readonly string[] {
    return ["minProperties", "maxProperties", "additionalProperties"];
  }

  protected mergeDescription(
    originalDescription: string | undefined,
    constraints: SchemaConstraints
  ): string {
    const constraintText = this.formatConstraintsForReasoningModel(
      constraints as OpenAIConstraints
    );
    if (originalDescription) {
      return `${originalDescription}\n\nIMPORTANT: ${constraintText}`;
    }
    return `IMPORTANT: ${constraintText}`;
  }

  private formatConstraintsForReasoningModel(constraints: OpenAIConstraints): string {
    const rules: string[] = [];

    if (constraints.minLength) {
      rules.push(`minimum ${constraints.minLength} characters`);
    }
    if (constraints.maxLength) {
      rules.push(`maximum ${constraints.maxLength} characters`);
    }
    if (constraints.minimum !== undefined) {
      rules.push(`must be >= ${constraints.minimum}`);
    }
    if (constraints.maximum !== undefined) {
      rules.push(`must be <= ${constraints.maximum}`);
    }
    if (constraints.format === "email") {
      rules.push(`must be a valid email address`);
    }
    if (constraints.format === "uri" || constraints.format === "url") {
      rules.push(`must be a valid URL`);
    }
    if (constraints.format === "uuid") {
      rules.push(`must be a valid UUID`);
    }
    if (constraints.pattern) {
      rules.push(`must match pattern: ${constraints.pattern}`);
    }
    if (constraints.enum) {
      rules.push(`must be one of: ${constraints.enum.join(", ")}`);
    }
    if (constraints.exclusiveMinimum !== undefined) {
      rules.push(`must be > ${constraints.exclusiveMinimum}`);
    }
    if (constraints.exclusiveMaximum !== undefined) {
      rules.push(`must be < ${constraints.exclusiveMaximum}`);
    }
    if (constraints.multipleOf !== undefined) {
      rules.push(`must be a multiple of ${constraints.multipleOf}`);
    }
    if (constraints.minItems) {
      rules.push(`array must have at least ${constraints.minItems} items`);
    }
    if (constraints.maxItems) {
      rules.push(`array must have at most ${constraints.maxItems} items`);
    }
    if (constraints.uniqueItems) {
      rules.push(`array items must be unique`);
    }
    if (constraints.minProperties !== undefined) {
      rules.push(`object must have at least ${constraints.minProperties} properties`);
    }
    if (constraints.maxProperties !== undefined) {
      rules.push(`object must have at most ${constraints.maxProperties} properties`);
    }
    if (constraints.additionalProperties === false) {
      rules.push(`additional properties are not allowed`);
    }

    // Every collected constraint was stripped from the schema, so the note
    // is the only place the model can learn it. Serialize any constraint
    // without a prose rule above instead of dropping it when another
    // constraint on the same property did render.
    const renderedKeys = new Set(
      [
        constraints.minLength && "minLength",
        constraints.maxLength && "maxLength",
        constraints.minimum !== undefined && "minimum",
        constraints.maximum !== undefined && "maximum",
        constraints.exclusiveMinimum !== undefined && "exclusiveMinimum",
        constraints.exclusiveMaximum !== undefined && "exclusiveMaximum",
        constraints.multipleOf !== undefined && "multipleOf",
        (constraints.format === "email" ||
          constraints.format === "uri" ||
          constraints.format === "url" ||
          constraints.format === "uuid") &&
          "format",
        constraints.pattern && "pattern",
        constraints.enum && "enum",
        constraints.minItems && "minItems",
        constraints.maxItems && "maxItems",
        constraints.uniqueItems !== undefined && "uniqueItems",
        constraints.minProperties !== undefined && "minProperties",
        constraints.maxProperties !== undefined && "maxProperties",
        constraints.additionalProperties !== undefined &&
          "additionalProperties",
      ].filter(Boolean) as string[],
    );
    const leftovers = Object.entries(constraints)
      .filter(([key, value]) => value !== undefined && !renderedKeys.has(key))
      .map(([key, value]) => `${key}: ${String(value)}`);

    if (rules.length === 0) {
      return leftovers.join(", ");
    }
    return [...rules, ...leftovers].join(", ");
  }
}
