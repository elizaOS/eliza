/**
 * Validation utilities.
 */

import { Memory } from "@elizaos/core";

/**
 * Validates if a memory contains a valid prompt.
 */
export function validatePrompt(message: Memory): boolean {
  if (!message?.content?.text) {
    return false;
  }

  const text = message.content.text.trim();
  return text.length > 0;
}

/**
 * Validates if text looks like a JSON specification.
 */
export function isValidJsonSpecification(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}


