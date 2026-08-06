import type { Conversation, ExportOptions } from "../types";
import { extractTextContent } from "../utils";

export function toPlainText(conv: Conversation, options: ExportOptions): string {
  const lines: string[] = [
    conv.title,
    "=".repeat(conv.title.length),
    "",
  ];

  if (conv.model) lines.push(`Model: ${conv.model}`);
  if (options.includeTimestamps) {
    lines.push(`Created: ${new Date(conv.createdAt).toLocaleString()}`);
  }
  lines.push("");

  let messages = conv.messages;
  if (options.dateRange) {
    const { start, end } = options.dateRange;
    messages = messages.filter((m) => m.createdAt >= start && m.createdAt <= end);
  }

  for (const msg of messages) {
    const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
    lines.push(`[${role}]${options.includeTimestamps ? ` (${new Date(msg.createdAt).toLocaleString()})` : ""}`);

    if (typeof msg.content === "string") {
      lines.push(msg.content);
    } else {
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push(block.text);
        } else if (block.type === "tool_use" && options.includeToolUse) {
          parts.push(`[Tool: ${block.name}]\nInput: ${JSON.stringify(block.input)}`);
        } else if (block.type === "tool_result" && options.includeToolUse) {
          const raw =
            typeof block.content === "string"
              ? block.content
              : extractTextContent(block.content);
          const text =
            !options.includeFileContents && raw.length > 500
              ? raw.slice(0, 500) + " …[truncated]"
              : raw;
          parts.push(`[Tool Result${block.is_error ? " (error)" : ""}]\n${text}`);
        }
      }
      lines.push(parts.join("\n\n"));
    }

    lines.push("");
  }

  lines.push("---");
  lines.push("Exported from Claude Code");

  return lines.join("\n");
}
