/** Adapts hosted MCP schemas to Anthropic's accepted tool-schema subset. */
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
    if (constraints.additionalProperties === false) hints.push("Only use the specified properties");
    if (constraints.format === "date-time") hints.push("Use ISO 8601 format");
    if (typeof constraints.pattern === "string" && constraints.pattern.length <= 512) {
      hints.push(`Must match: ${constraints.pattern}`);
    }
    if (
      constraints.additionalProperties !== undefined &&
      constraints.additionalProperties !== true &&
      constraints.additionalProperties !== false
    ) {
      const diagnostic = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(diagnostic, "additionalProperties", {
        value: constraints.additionalProperties,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      hints.push(this.serializeDiagnostic(diagnostic));
    }

    const text = hints.join(". ");
    return original && text ? `${original}. ${text}` : original || text || "";
  }
}
