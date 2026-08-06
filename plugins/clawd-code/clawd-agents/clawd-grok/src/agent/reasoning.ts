import type { ModelMessage } from "ai";

const ENCRYPTED_REASONING_MARKERS = [
  "-----BEGIN PGP MESSAGE-----",
  "-----BEGIN PGP ARMORED FILE-----",
  "-----BEGIN AGE ENCRYPTED FILE-----",
  "encrypted_content",
] as const;
type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;
type AssistantContent = AssistantMessage["content"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getReasoningText(part: unknown): string | null {
  if (!isRecord(part) || part.type !== "reasoning") return null;
  if (typeof part.text === "string") return part.text;
  if (typeof part.reasoning === "string") return part.reasoning;
  return null;
}

export function containsEncryptedReasoning(text: string): boolean {
  const lower = text.toLowerCase();
  return ENCRYPTED_REASONING_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

function sanitizeAssistantContent(content: AssistantContent): AssistantContent {
  if (!Array.isArray(content)) return content;

  const filtered = content.filter((part) => {
    const reasoningText = getReasoningText(part);
    return !reasoningText || !containsEncryptedReasoning(reasoningText);
  });

  return filtered.length === content.length ? content : (filtered as typeof content);
}

export function sanitizeModelMessages(messages: ModelMessage[]): ModelMessage[] {
  let changed = false;
  const sanitized: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role !== "assistant") {
      sanitized.push(message);
      continue;
    }

    const content = sanitizeAssistantContent(message.content);
    if (content !== message.content) {
      changed = true;
    }

    if (Array.isArray(content) && content.length === 0) {
      changed = true;
      continue;
    }

    const nextMessage: ModelMessage = content === message.content ? message : { ...message, content };
    sanitized.push(nextMessage);
  }

  return changed ? sanitized : messages;
}
