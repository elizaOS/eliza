/**
 * Text processor for TTS
 *
 * Handles text cleaning, length limits, and summarization
 */

import type { IAgentRuntime } from "@elizaos/core";

/**
 * Clean text for TTS synthesis
 * Removes markdown, code blocks, and other non-speech content
 */
export function cleanTextForTts(text: string): string {
  let cleaned = text;

  // Remove code blocks
  cleaned = cleaned.replace(/```[\s\S]*?```/g, "[code block]");

  // Remove inline code
  cleaned = cleaned.replace(/`[^`]+`/g, "[code]");

  // Remove markdown links but keep link text (before URL replacement so URL is inside parentheses)
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Remove URLs
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/g, "[link]");

  // Remove markdown bold/italic
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, "$1");
  cleaned = cleaned.replace(/\*([^*]+)\*/g, "$1");
  cleaned = cleaned.replace(/__([^_]+)__/g, "$1");
  cleaned = cleaned.replace(/_([^_]+)_/g, "$1");

  // Remove markdown headers
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, "");

  // Remove HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, "");

  // Convert multiple newlines to single
  cleaned = cleaned.replace(/\n{2,}/g, "\n");

  // Remove leading/trailing whitespace
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Truncate text to max length, trying to break at sentence boundaries
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  // Try to break at sentence boundary
  const truncated = text.slice(0, maxLength);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? "),
    truncated.lastIndexOf(".\n"),
    truncated.lastIndexOf("!\n"),
    truncated.lastIndexOf("?\n"),
  );

  if (lastSentenceEnd >= 0) {
    return truncated.slice(0, lastSentenceEnd + 1).trim();
  }

  // Fall back to word boundary
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.8) {
    return truncated.slice(0, lastSpace).trim() + "...";
  }

  return truncated.trim() + "...";
}

/**
 * Summarize text using LLM for TTS
 */
export async function summarizeForTts(
  runtime: IAgentRuntime,
  text: string,
  maxLength: number,
): Promise<string> {
  try {
    const prompt = `Summarize the following text in ${maxLength} characters or less for text-to-speech. Keep the key points and maintain a conversational tone:\n\n${text}`;

    const response = await runtime.useModel("TEXT_SMALL", {
      prompt,
      maxTokens: Math.ceil(maxLength / 3), // Rough estimate
    });

    if (typeof response === "string") {
      return response.slice(0, maxLength);
    }

    // Fallback to truncation
    return truncateText(text, maxLength);
  } catch {
    // Fallback to truncation on error
    return truncateText(text, maxLength);
  }
}

/**
 * Process text for TTS synthesis
 * Cleans, validates length, and optionally summarizes
 */
export async function processTextForTts(
  runtime: IAgentRuntime,
  text: string,
  options: {
    maxLength: number;
    summarize: boolean;
    minLength?: number;
  },
): Promise<string | null> {
  const { maxLength, summarize, minLength = 10 } = options;

  // Clean the text
  let processed = cleanTextForTts(text);

  // Check minimum length
  if (processed.length < minLength) {
    return null;
  }

  // Check maximum length
  if (processed.length > maxLength) {
    if (summarize) {
      processed = await summarizeForTts(runtime, processed, maxLength);
    } else {
      processed = truncateText(processed, maxLength);
    }
  }

  return processed;
}
