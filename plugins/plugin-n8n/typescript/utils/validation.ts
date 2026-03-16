import type { Memory } from "@elizaos/core";

export function validatePrompt(message: Memory): boolean {
  if (!message?.content?.text) {
    return false;
  }

  const text = message.content.text.trim();
  return text.length > 0;
}

export function isValidJsonSpecification(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
