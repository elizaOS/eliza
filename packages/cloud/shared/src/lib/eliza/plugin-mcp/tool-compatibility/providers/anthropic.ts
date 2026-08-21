// Wires hosted Eliza agent anthropic behavior for cloud runtime services.
import { McpToolCompatibility, type ModelInfo } from "../base";

export class AnthropicMcpCompatibility extends McpToolCompatibility {
  constructor(modelInfo: ModelInfo) {
    super(modelInfo);
  }

  shouldApply(): boolean {
    return this.modelInfo.provider === "anthropic";
  }

  protected getUnsupportedStringProperties(): string[] {
    return [];
  }
  protected getUnsupportedNumberProperties(): string[] {
    return [];
  }
  protected getUnsupportedArrayProperties(): string[] {
    return [];
  }
  protected getUnsupportedObjectProperties(): string[] {
    return ["additionalProperties"];
  }

  protected mergeDescription(
    original: string | undefined,
    constraints: Record<string, unknown>,
  ): string {
    const hints: string[] = [];
    const rendered = new Set<string>();
    if (constraints.additionalProperties === false) {
      hints.push("Only use the specified properties");
      rendered.add("additionalProperties");
    }
    if (constraints.format === "date-time") hints.push("Use ISO 8601 format");
    if (typeof constraints.pattern === "string") hints.push(`Must match: ${constraints.pattern}`);

    const additionalProperties = constraints.additionalProperties;
    if (additionalProperties !== undefined && !rendered.has("additionalProperties")) {
      hints.push(this.stringifyConstraints({ additionalProperties }));
    }

    const text = hints.join(". ");
    return original && text ? `${original}. ${text}` : original || text || "";
  }
}
