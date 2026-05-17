import { McpToolCompatibility, type SchemaConstraints } from "../base";

interface AnthropicConstraints {
  additionalProperties?: boolean;
  format?: string;
  pattern?: string;
}

export class AnthropicMcpCompatibility extends McpToolCompatibility {
  shouldApply(): boolean {
    return this.modelInfo.provider === "anthropic";
  }

  protected getUnsupportedStringProperties(): readonly string[] {
    return [];
  }

  protected getUnsupportedNumberProperties(): readonly string[] {
    return [];
  }

  protected getUnsupportedArrayProperties(): readonly string[] {
    return [];
  }

  protected getUnsupportedObjectProperties(): readonly string[] {
    return ["additionalProperties"];
  }

  protected mergeDescription(
    originalDescription: string | undefined,
    constraints: SchemaConstraints
  ): string {
    const constraintHints = this.formatConstraintsForAnthropic(constraints as AnthropicConstraints);
    if (originalDescription && constraintHints) {
      return `${originalDescription}. ${constraintHints}`;
    } else if (constraintHints) {
      return constraintHints;
    }
    return originalDescription ?? "";
  }

  private formatConstraintsForAnthropic(constraints: AnthropicConstraints): string {
    const hints: string[] = [];

    if (constraints.additionalProperties === false) {
      hints.push("Only use the specified properties");
    }
    if (constraints.format === "date-time") {
      hints.push("Use ISO 8601 date-time format");
    }
    if (constraints.pattern) {
      hints.push(`Must match the pattern: ${constraints.pattern}`);
    }

    return hints.join(". ");
  }
}
