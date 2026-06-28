import { McpToolCompatibility, type ModelInfo } from "../base";

export class GoogleMcpCompatibility extends McpToolCompatibility {
  constructor(modelInfo: ModelInfo) {
    super(modelInfo);
  }

  shouldApply(): boolean {
    return this.modelInfo.provider === "google";
  }

  protected getUnsupportedStringProperties(): string[] {
    return ["minLength", "maxLength", "pattern", "format"];
  }

  protected getUnsupportedNumberProperties(): string[] {
    return ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"];
  }

  protected getUnsupportedArrayProperties(): string[] {
    return ["minItems", "maxItems", "uniqueItems"];
  }

  protected getUnsupportedObjectProperties(): string[] {
    return ["minProperties", "maxProperties", "additionalProperties"];
  }

  protected mergeDescription(
    original: string | undefined,
    constraints: Record<string, unknown>,
  ): string {
    const rules: string[] = [];
    if (constraints.minLength) rules.push(`at least ${constraints.minLength} chars`);
    if (constraints.maxLength) rules.push(`at most ${constraints.maxLength} chars`);
    if (constraints.minimum !== undefined) rules.push(`>= ${constraints.minimum}`);
    if (constraints.maximum !== undefined) rules.push(`<= ${constraints.maximum}`);
    if (constraints.format === "email") rules.push(`valid email`);
    if (constraints.format === "uri" || constraints.format === "url") rules.push(`valid URL`);
    if (constraints.pattern) rules.push(`matches ${constraints.pattern}`);
    if (constraints.enum) rules.push(`one of: ${(constraints.enum as string[]).join(", ")}`);
    if (constraints.minItems) rules.push(`>= ${constraints.minItems} items`);
    if (constraints.maxItems) rules.push(`<= ${constraints.maxItems} items`);
    if (constraints.uniqueItems) rules.push(`unique items`);

    const text = rules.length > 0 ? `Constraints: ${rules.join("; ")}` : "";
    return original && text ? `${original}\n\n${text}` : original || text;
  }
}
