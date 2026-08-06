import type { Conversation, Message, ExportOptions } from "../types";
import { extractTextContent } from "../utils";

function renderMessage(msg: Message, options: ExportOptions): string {
  const parts: string[] = [];

  const roleLabel =
    msg.role === "user"
      ? "**User**"
      : msg.role === "assistant"
      ? "**Assistant**"
      : `**${msg.role}**`;

  parts.push(`### ${roleLabel}`);

  if (options.includeTimestamps) {
    parts.push(`_${new Date(msg.createdAt).toLocaleString()}_\n`);
  }

  if (typeof msg.content === "string") {
    parts.push(msg.content);
  } else {
    for (const block of msg.content) {
      if (block.type === "text") {
        parts.push(block.text);
      } else if (block.type === "tool_use" && options.includeToolUse) {
        parts.push(
          `\`\`\`tool-use\n// Tool: ${block.name}\n${JSON.stringify(block.input, null, 2)}\n\`\`\``
        );
      } else if (block.type === "tool_result" && options.includeToolUse) {
        const raw =
          typeof block.content === "string"
            ? block.content
            : extractTextContent(block.content);
        const truncated =
          !options.includeFileContents && raw.length > 500
            ? raw.slice(0, 500) + "\n…[truncated]"
            : raw;
        parts.push(
          `\`\`\`tool-result${block.is_error ? " error" : ""}\n${truncated}\n\`\`\``
        );
      }
    }
  }

  return parts.join("\n\n");
}

export function toMarkdown(conv: Conversation, options: ExportOptions): string {
  const lines: string[] = [
    `# ${conv.title}`,
    "",
    "---",
    ...(options.includeTimestamps
      ? [`**Created:** ${new Date(conv.createdAt).toISOString()}`]
      : []),
    ...(conv.model ? [`**Model:** ${conv.model}`] : []),
    `**Messages:** ${conv.messages.length}`,
    "---",
    "",
  ];

  let messages = conv.messages;
  if (options.dateRange) {
    const { start, end } = options.dateRange;
    messages = messages.filter((m) => m.createdAt >= start && m.createdAt <= end);
  }

  for (const msg of messages) {
    lines.push(renderMessage(msg, options));
    lines.push("");
  }

  lines.push("---");
  lines.push("*Exported from Claude Code*");

  return lines.join("\n");
}
