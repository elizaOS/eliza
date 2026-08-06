import type { ToolResult } from "../types/index";

export function extractToolResultFromOutput(output: unknown): ToolResult | null {
  if (!output || typeof output !== "object") return null;

  if ("success" in output) {
    const result = output as ToolResult;
    return {
      success: Boolean(result.success),
      output: result.output,
      error: result.error,
      diff: result.diff,
      plan: result.plan,
      task: result.task,
      delegation: result.delegation,
      backgroundProcess: result.backgroundProcess,
      media: result.media,
      computer: result.computer,
    };
  }

  if ("type" in output && output.type === "json" && "value" in output) {
    return extractToolResultFromOutput((output as { value: unknown }).value);
  }

  if ("type" in output && output.type === "error-text" && "value" in output) {
    return {
      success: false,
      error: String((output as { value: unknown }).value),
    };
  }

  if ("type" in output && output.type === "text" && "value" in output) {
    return {
      success: true,
      output: String((output as { value: unknown }).value),
    };
  }

  return null;
}

export function getOutputKind(output: unknown): string {
  if (output && typeof output === "object" && "type" in output && typeof output.type === "string") {
    return output.type;
  }
  return "json";
}

export function isOutputSuccess(output: unknown): boolean {
  if (!output || typeof output !== "object") return true;
  if ("type" in output) {
    return !String(output.type).startsWith("error");
  }
  return true;
}
