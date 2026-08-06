import type { Conversation, Message, ExportOptions, ContentBlock } from "../types";

function filterContent(
  content: ContentBlock[] | string,
  options: ExportOptions
): ContentBlock[] | string {
  if (typeof content === "string") return content;

  return content.filter((block) => {
    if (block.type === "tool_use" || block.type === "tool_result") {
      return options.includeToolUse;
    }
    return true;
  });
}

function filterMessage(msg: Message, options: ExportOptions): Message {
  return {
    ...msg,
    content: filterContent(msg.content, options),
    createdAt: options.includeTimestamps ? msg.createdAt : 0,
  };
}

export function toJSON(conv: Conversation, options: ExportOptions): string {
  let messages = conv.messages;

  if (options.dateRange) {
    const { start, end } = options.dateRange;
    messages = messages.filter((m) => m.createdAt >= start && m.createdAt <= end);
  }

  const output = {
    id: conv.id,
    title: conv.title,
    model: conv.model,
    createdAt: options.includeTimestamps ? conv.createdAt : undefined,
    updatedAt: options.includeTimestamps ? conv.updatedAt : undefined,
    messageCount: messages.length,
    messages: messages.map((m) => filterMessage(m, options)),
    exportedAt: new Date().toISOString(),
  };

  return JSON.stringify(output, null, 2);
}
