// Wires hosted Eliza agent openai behavior for cloud runtime services.
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

  /**
   * Reasoning models reject the constraint keywords stripped above, so every
   * stripped bound has to survive as prose or the model is never told about a
   * rule it must still satisfy. Two failure modes are guarded here: a bound of
   * zero is a legitimate constraint and must not be dropped by a truthy test,
   * and a collected keyword with no rule of its own must still reach the
   * description rather than vanishing because some *other* keyword happened to
   * render (the previous all-or-nothing fallback only fired when zero rules
   * matched, which silently lost `multipleOf` from `{minimum, multipleOf}`).
   */
  protected mergeDescription(
    original: string | undefined,
    constraints: Record<string, unknown>,
  ): string {
    const rules: string[] = [];
    const rendered = new Set<string>();
    const rule = (key: string, text: string): void => {
      rules.push(text);
      rendered.add(key);
    };

    if (constraints.minLength !== undefined)
      rule("minLength", `minimum ${constraints.minLength} characters`);
    if (constraints.maxLength !== undefined)
      rule("maxLength", `maximum ${constraints.maxLength} characters`);
    if (constraints.minimum !== undefined) rule("minimum", `must be >= ${constraints.minimum}`);
    if (constraints.maximum !== undefined) rule("maximum", `must be <= ${constraints.maximum}`);
    if (constraints.exclusiveMinimum !== undefined)
      rule("exclusiveMinimum", `must be > ${constraints.exclusiveMinimum}`);
    if (constraints.exclusiveMaximum !== undefined)
      rule("exclusiveMaximum", `must be < ${constraints.exclusiveMaximum}`);
    if (constraints.multipleOf !== undefined)
      rule("multipleOf", `must be a multiple of ${constraints.multipleOf}`);
    if (constraints.format === "email") rule("format", `must be a valid email`);
    if (constraints.format === "uri" || constraints.format === "url")
      rule("format", `must be a valid URL`);
    if (constraints.pattern !== undefined) rule("pattern", `must match: ${constraints.pattern}`);
    if (constraints.enum !== undefined)
      rule("enum", `must be one of: ${(constraints.enum as string[]).join(", ")}`);
    if (constraints.minItems !== undefined)
      rule("minItems", `at least ${constraints.minItems} items`);
    if (constraints.maxItems !== undefined)
      rule("maxItems", `at most ${constraints.maxItems} items`);
    if (constraints.uniqueItems === true) rule("uniqueItems", `items must be unique`);
    if (constraints.minProperties !== undefined)
      rule("minProperties", `at least ${constraints.minProperties} properties`);
    if (constraints.maxProperties !== undefined)
      rule("maxProperties", `at most ${constraints.maxProperties} properties`);

    const unrendered = Object.keys(constraints).filter((key) => !rendered.has(key));
    const parts: string[] = [];
    if (rules.length > 0) parts.push(`IMPORTANT: ${rules.join(", ")}`);
    if (unrendered.length > 0) {
      parts.push(
        JSON.stringify(Object.fromEntries(unrendered.map((key) => [key, constraints[key]]))),
      );
    }

    const text = parts.join(" ");
    return original ? `${original}\n\n${text}` : text;
  }
}
