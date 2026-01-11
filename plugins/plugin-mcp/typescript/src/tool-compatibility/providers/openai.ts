import { McpToolCompatibility, type SchemaConstraints } from "../base";

interface OpenAIConstraints {
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: string;
  pattern?: string;
  enum?: readonly string[];
  minItems?: number;
  maxItems?: number;
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
    if (constraints.minItems) {
      rules.push(`array must have at least ${constraints.minItems} items`);
    }
    if (constraints.maxItems) {
      rules.push(`array must have at most ${constraints.maxItems} items`);
    }

    return rules.length > 0 ? rules.join(", ") : JSON.stringify(constraints);
  }
}
