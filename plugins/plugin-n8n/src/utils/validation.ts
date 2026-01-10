import { Memory, Content } from '@elizaos/core';

/**
 * Validates if a memory contains a valid prompt
 */
export function validatePrompt(message: Memory): boolean {
  if (!message || !message.content || !message.content.text) {
    return false;
  }

  // Check if the text content is meaningful
  const text = message.content.text.trim();
  return text.length > 0;
}

/**
 * Validates if text looks like a JSON specification
 */
export function isValidJsonSpecification(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
