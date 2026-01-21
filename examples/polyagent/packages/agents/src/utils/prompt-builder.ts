/**
 * Safe Prompt Builder for Agents
 *
 * Ensures prompts stay under model context limits and consolidates prompt
 * building logic to prevent context window overflow.
 *
 * @packageDocumentation
 */

import {
  countTokensSync,
  getModelTokenLimit,
  truncateToTokenLimitSync,
} from "@polyagent/api";
import { logger } from "../shared/logger";

export interface PromptSection {
  name: string;
  content: string;
  priority: number; // Higher = more important, kept if truncation needed
  minTokens?: number; // Minimum tokens to keep (for critical sections)
}

/**
 * Builds a safe prompt that fits within model context limits
 *
 * @param sections - Ordered prompt sections with priorities
 * @param model - Model name (for context limit lookup)
 * @param safetyMargin - Tokens to reserve (default: 2000)
 * @returns Truncated prompt that fits within context limit
 */
export function buildSafePrompt(
  sections: PromptSection[],
  model = "unsloth/Qwen3-4B-128K",
  safetyMargin = 2000,
): {
  prompt: string;
  truncated: boolean;
  originalTokens: number;
  finalTokens: number;
} {
  // Get model limit
  const modelLimit = getModelTokenLimit(model);
  const maxPromptTokens = modelLimit - safetyMargin;

  // Build initial prompt
  const fullPrompt = sections
    .sort((a, b) => b.priority - a.priority) // Highest priority first
    .map((s) => s.content)
    .join("\n\n");

  // Count tokens
  const estimatedTokens = countTokensSync(fullPrompt);

  // Check if within limit
  if (estimatedTokens <= maxPromptTokens) {
    return {
      prompt: fullPrompt,
      truncated: false,
      originalTokens: estimatedTokens,
      finalTokens: estimatedTokens,
    };
  }

  // Need to truncate - use priority-based approach
  logger.warn(
    `Prompt exceeds limit: ${estimatedTokens} > ${maxPromptTokens}, truncating`,
    {
      model,
      estimatedTokens,
      limit: maxPromptTokens,
    },
  );

  // Keep high-priority sections, truncate low-priority
  const sortedSections = [...sections].sort((a, b) => b.priority - a.priority);
  let currentTokens = 0;
  const keptSections: string[] = [];

  for (const section of sortedSections) {
    const sectionTokens = countTokensSync(section.content);
    const minRequired = section.minTokens || 0;

    if (currentTokens + sectionTokens <= maxPromptTokens) {
      // Fits completely
      keptSections.push(section.content);
      currentTokens += sectionTokens;
    } else if (currentTokens + minRequired <= maxPromptTokens) {
      // Truncate this section to fit
      const available = maxPromptTokens - currentTokens;
      const truncated = truncateToTokenLimitSync(section.content, available, {
        ellipsis: true,
      });
      keptSections.push(truncated.text);
      currentTokens += truncated.tokens;
      break; // Stop here
    } else {
      // Can't fit even minimum - skip lower priority sections
      break;
    }
  }

  const finalPrompt = keptSections.join("\n\n");
  const finalTokens = countTokensSync(finalPrompt);

  logger.info("Prompt truncated successfully", {
    original: estimatedTokens,
    final: finalTokens,
    sectionsKept: keptSections.length,
    sectionsTotal: sections.length,
  });

  return {
    prompt: finalPrompt,
    truncated: true,
    originalTokens: estimatedTokens,
    finalTokens,
  };
}

/**
 * Quick prompt builder for simple cases
 * Automatically truncates if needed
 */
export function buildPrompt(
  systemPrompt: string,
  userPrompt: string,
  model = "unsloth/Qwen3-4B-128K",
): string {
  const result = buildSafePrompt(
    [
      { name: "system", content: systemPrompt, priority: 100, minTokens: 500 },
      { name: "user", content: userPrompt, priority: 90, minTokens: 1000 },
    ],
    model,
  );

  if (result.truncated) {
    logger.warn(
      `Prompt was truncated from ${result.originalTokens} to ${result.finalTokens} tokens`,
    );
  }

  return result.prompt;
}

/**
 * Estimate if a prompt will fit within model limits
 */
export function willPromptFit(
  prompt: string,
  model = "unsloth/Qwen3-4B-128K",
  safetyMargin = 2000,
): { fits: boolean; tokens: number; limit: number } {
  const tokens = countTokensSync(prompt);
  const limit = getModelTokenLimit(model) - safetyMargin;

  return {
    fits: tokens <= limit,
    tokens,
    limit,
  };
}
