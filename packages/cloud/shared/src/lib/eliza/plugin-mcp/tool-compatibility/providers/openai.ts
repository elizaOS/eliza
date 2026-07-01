import { McpToolCompatibility, type ModelInfo } from "../base";

export class OpenAIMcpCompatibility extends McpToolCompatibility {
  constructor(modelInfo: ModelInfo) {
    super(modelInfo);
  }

  shouldApply(): boolean {
    return (
      this.modelInfo.provider === "openai" &&
      (!this.modelInfo.supportsStructuredOutputs || this.modelInfo.isReasoningModel === true)
    );
  }

  protected getUnsupportedStringProperties(): string[] {
    return this.modelInfo.isReasoningModel || this.modelInfo.modelId.includes("gpt-3.5")
      ? ["format", "pattern"]
      : ["format"];
  }

  protected getUnsupportedNumberProperties(): string[] {
    return this.modelInfo.isReasoningModel
      ? ["exclusiveMinimum", "exclusiveMaximum", "multipleOf"]
      : [];
  }

  protected getUnsupportedArrayProperties(): string[] {
    return this.modelInfo.isReasoningModel ? ["uniqueItems"] : [];
  }

  protected getUnsupportedObjectProperties(): string[] {
    return ["minProperties", "maxProperties"];
  }
}

export class OpenAIReasoningMcpCompatibility extends McpToolCompatibility {
  constructor(modelInfo: ModelInfo) {
    super(modelInfo);
  }

  shouldApply(): boolean {
    return this.modelInfo.provider === "openai" && this.modelInfo.isReasoningModel === true;
  }

  protected getUnsupportedStringProperties(): string[] {
    return ["format", "pattern", "minLength", "maxLength"];
  }

  protected getUnsupportedNumberProperties(): string[] {
    return ["exclusiveMinimum", "exclusiveMaximum", "multipleOf"];
  }

  protected getUnsupportedArrayProperties(): string[] {
    return ["uniqueItems", "minItems", "maxItems"];
  }

  protected getUnsupportedObjectProperties(): string[] {
    return ["minProperties", "maxProperties", "additionalProperties"];
  }

  protected mergeDescription(
    original: string | undefined,
    constraints: Record<string, unknown>,
  ): string {
    const rules: string[] = [];
    if (constraints.minLength) rules.push(`minimum ${constraints.minLength} characters`);
    if (constraints.maxLength) rules.push(`maximum ${constraints.maxLength} characters`);
    if (constraints.minimum !== undefined) rules.push(`must be >= ${constraints.minimum}`);
    if (constraints.maximum !== undefined) rules.push(`must be <= ${constraints.maximum}`);
    if (constraints.format === "email") rules.push(`must be a valid email`);
    if (constraints.format === "uri" || constraints.format === "url")
      rules.push(`must be a valid URL`);
    if (constraints.pattern) rules.push(`must match: ${constraints.pattern}`);
    if (constraints.enum)
      rules.push(`must be one of: ${(constraints.enum as string[]).join(", ")}`);
    if (constraints.minItems) rules.push(`at least ${constraints.minItems} items`);
    if (constraints.maxItems) rules.push(`at most ${constraints.maxItems} items`);

    const text = rules.length > 0 ? `IMPORTANT: ${rules.join(", ")}` : JSON.stringify(constraints);
    return original ? `${original}\n\n${text}` : text;
  }
}
