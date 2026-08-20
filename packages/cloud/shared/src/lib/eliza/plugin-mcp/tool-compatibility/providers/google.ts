// Wires hosted Eliza agent google behavior for cloud runtime services.
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
    const rendered = new Set<string>();
    const rule = (key: string, text: string): void => {
      rules.push(text);
      rendered.add(key);
    };
    const finiteNumber = (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value);
    const nonNegativeInteger = (value: unknown): value is number =>
      finiteNumber(value) && Number.isInteger(value) && value >= 0;
    const positiveNumber = (value: unknown): value is number => finiteNumber(value) && value > 0;

    if (nonNegativeInteger(constraints.minLength))
      rule("minLength", `at least ${constraints.minLength} chars`);
    if (nonNegativeInteger(constraints.maxLength))
      rule("maxLength", `at most ${constraints.maxLength} chars`);
    if (finiteNumber(constraints.minimum)) rule("minimum", `>= ${constraints.minimum}`);
    if (finiteNumber(constraints.maximum)) rule("maximum", `<= ${constraints.maximum}`);
    if (finiteNumber(constraints.exclusiveMinimum))
      rule("exclusiveMinimum", `> ${constraints.exclusiveMinimum}`);
    if (finiteNumber(constraints.exclusiveMaximum))
      rule("exclusiveMaximum", `< ${constraints.exclusiveMaximum}`);
    if (positiveNumber(constraints.multipleOf))
      rule("multipleOf", `multiple of ${constraints.multipleOf}`);
    if (constraints.format === "email") rule("format", "valid email");
    if (constraints.format === "uri" || constraints.format === "url") rule("format", "valid URL");
    if (typeof constraints.pattern === "string") rule("pattern", `matches ${constraints.pattern}`);
    if (Array.isArray(constraints.enum) && constraints.enum.length > 0)
      rule("enum", `one of: ${constraints.enum.map((value) => JSON.stringify(value)).join(", ")}`);
    if (nonNegativeInteger(constraints.minItems))
      rule("minItems", `>= ${constraints.minItems} items`);
    if (nonNegativeInteger(constraints.maxItems))
      rule("maxItems", `<= ${constraints.maxItems} items`);
    if (constraints.uniqueItems === true) rule("uniqueItems", "unique items");
    if (nonNegativeInteger(constraints.minProperties))
      rule("minProperties", `>= ${constraints.minProperties} properties`);
    if (nonNegativeInteger(constraints.maxProperties))
      rule("maxProperties", `<= ${constraints.maxProperties} properties`);
    if (constraints.additionalProperties === false)
      rule("additionalProperties", "no additional properties");

    const unrendered = Object.keys(constraints).filter((key) => !rendered.has(key));
    const parts: string[] = [];
    if (rules.length > 0) parts.push(`Constraints: ${rules.join("; ")}`);
    if (unrendered.length > 0) {
      parts.push(
        this.stringifyConstraints(
          Object.fromEntries(unrendered.map((key) => [key, constraints[key]])),
        ),
      );
    }

    const text = parts.join(" ");
    return original && text ? `${original}\n\n${text}` : original || text;
  }
}
