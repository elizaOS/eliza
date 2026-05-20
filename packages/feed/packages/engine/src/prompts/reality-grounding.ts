/**
 * Reality Grounding - Current World State
 *
 * Provides current date, prices, politics, culture, and tech landscape
 * to ground LLM outputs in current reality and prevent outdated predictions.
 *
 * Facts are loaded directly from TypeScript modules for serverless compatibility.
 */

import { realityGroundingContent } from '../data/reality-grounding';
import { worldEventExamplesContent } from '../data/world-event-examples';
import { worldFactsContent } from '../data/world-facts';

/**
 * Get current date and time context for prompts.
 *
 * Returns various formatted date/time strings updated dynamically
 * at generation time. Used to ensure all generated content references
 * the current date correctly.
 *
 * @returns Object containing:
 *   - `dateISO`: ISO 8601 formatted date string
 *   - `dateFull`: Full human-readable date (e.g., "Monday, November 16, 2025")
 *   - `time`: Formatted time (e.g., "3:45 PM")
 *   - `year`: Current year as string
 *   - `month`: Current month name (e.g., "November")
 *   - `day`: Current day of month as string
 */
export function getCurrentDateContext(): {
  dateISO: string;
  dateFull: string;
  time: string;
  year: string;
  month: string;
  day: string;
} {
  const now = new Date();
  return {
    dateISO: now.toISOString(),
    dateFull: now.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }),
    time: now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }),
    year: now.getFullYear().toString(),
    month: now.toLocaleDateString('en-US', { month: 'long' }),
    day: now.getDate().toString(),
  };
}

/**
 * Get world event examples for style and tone context.
 *
 * Returns the world event examples content to provide the LLM with
 * examples of the desired satirical/news style.
 */
export function getWorldEventExamples(): string {
  return `=== WORLD EVENT EXAMPLES (FOR STYLE AND TONE) ===\n\n${worldEventExamplesContent}`;
}

/**
 * Get world facts content.
 *
 * Returns general facts about the game world.
 */
export function getWorldFacts(): string {
  return worldFactsContent;
}

/**
 * Get full reality grounding string.
 *
 * Returns all reality grounding facts formatted with the current date
 * dynamically inserted.
 *
 * @returns Full reality grounding string with current date and all facts
 */
export function getFullRealityGrounding(): string {
  const dateCtx = getCurrentDateContext();

  return `
=== CURRENT DATE: ${dateCtx.dateFull} ===

${realityGroundingContent}
`.trim();
}

/**
 * Validate generated text for reality-grounding violations.
 *
 * Checks for the most egregious issues: real-world names leaking through
 * instead of parody names, and prices that are wildly off from current
 * reality. Does NOT hard-code specific years or political figures because
 * those become stale — instead enforces structural rules.
 */
export function checkRealityGrounding(text: string): string[] {
  const warnings: string[] = [];

  // Check for real-world names that should always be replaced with parody names.
  // Keep this list minimal — only the highest-signal leaks.
  const realNameLeaks: Array<{ pattern: RegExp; message: string }> = [
    {
      pattern: /\bElon Musk\b/i,
      message: 'Real name "Elon Musk" — should be "AIlon Musk"',
    },
    {
      pattern: /\bSam Altman\b/i,
      message: 'Real name "Sam Altman" — should be "Sam AIltman"',
    },
    {
      pattern: /\bMark Zuckerberg\b/i,
      message: 'Real name "Mark Zuckerberg" — should be "Mark Zuckerborg"',
    },
    {
      pattern: /\bOpenAI\b(?!\s*(?:->|→|parody))/,
      message: 'Real org "OpenAI" — should be "OpenAGI"',
    },
    {
      pattern: /\bAnthropic\b(?!\s*(?:->|→|parody))/,
      message: 'Real org "Anthropic" — should be "AInthropic"',
    },
    {
      pattern: /\bDeepSeek\b(?!\s*(?:->|→|parody))/,
      message: 'Real org "DeepSeek" — should be "DeepSAIek"',
    },
  ];

  for (const { pattern, message } of realNameLeaks) {
    if (pattern.test(text)) {
      warnings.push(message);
    }
  }

  // Check for wildly outdated crypto prices (orders of magnitude off)
  if (/Bitcoin|BTC/i.test(text) && /\$[1-4]\d{0,3}(?:\s|,|$)/i.test(text)) {
    warnings.push(
      'Content may reference outdated Bitcoin price (current ~$78k)'
    );
  }

  return warnings;
}

/**
 * Get a concise reality grounding string for prompts.
 *
 * Returns the full content as it's designed to be injected whole.
 *
 * @returns Concise reality grounding string with current date and key facts
 */
export function getRealityGrounding(): string {
  const dateCtx = getCurrentDateContext();

  return `
=== REALITY GROUNDING (${dateCtx.dateFull}) ===

${realityGroundingContent}

CRITICAL: Ground all predictions in this reality. Use current dates, prices, and leadership.
`.trim();
}

/**
 * Get a minimal reality check string for quick context.
 *
 * Returns a very brief summary of key current facts.
 * Useful when token limits are tight or only basic grounding is needed.
 *
 * @returns Minimal reality grounding string
 */
export function getMinimalRealityGrounding(): string {
  const dateCtx = getCurrentDateContext();
  const lines = realityGroundingContent
    .split('\n')
    .filter((l) => l.trim().length > 0 && !l.startsWith('#'))
    .slice(0, 5);
  const keyFacts = lines.join(' | ');

  return `DATE: ${dateCtx.dateFull} | ${keyFacts}`;
}
