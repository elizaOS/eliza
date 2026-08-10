/**
 * Untrusted-value guards shared by the Google MCP service, capability host,
 * adapters, and connector provider. MCP payloads and OAuth responses are
 * external input, so every consumer narrows through these helpers instead of
 * repeating ad-hoc checks.
 */
import type { McpResourceEngine } from "@elizaos/plugin-mcp/resource-engine";

export type McpToolResult = Awaited<ReturnType<McpResourceEngine["callTool"]>>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Non-blank string narrowed and trimmed; undefined otherwise. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Non-blank string returned verbatim (no trim); undefined otherwise. Calendar
 * event fields keep their exact provider representation.
 */
export function optionalRawString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Joined text content of an MCP tool result, trimmed; empty when none. */
export function mcpResultText(result: McpToolResult): string {
  return result.content
    .filter(
      (content): content is Extract<McpToolResult["content"][number], { type: "text" }> =>
        content.type === "text"
    )
    .map((content) => content.text)
    .join("\n")
    .trim();
}
