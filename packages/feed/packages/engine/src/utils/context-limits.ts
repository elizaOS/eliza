/**
 * Context Limits Configuration
 *
 * Defines limits for context building optimized for 128k context window models.
 * Limits are generous to maximize context richness while leaving room for
 * prompt instructions and output tokens.
 *
 * Approximate token calculations:
 * - 1 token ≈ 4 characters (for English text)
 * - 128k context window ≈ 512k characters max
 * - We target ~80k tokens (~320k chars) to utilize most of the context window
 *   - Prompt instructions/templates: ~10k tokens
 *   - Output tokens: ~8k tokens
 *   - Safety buffer: ~30k tokens
 */

/**
 * Maximum lengths for text fields (in characters, approximate tokens = chars / 4)
 */
export const CONTEXT_LIMITS = {
  // Event limits - generous to capture full narrative history
  MAX_EVENT_DESCRIPTION_LENGTH: 300, // ~75 tokens - capture more detail
  MAX_EVENTS_PERSONAL: 30, // Events NPC was involved in
  MAX_EVENTS_RECENT: 100, // Recent world events - larger window
  MAX_EVENTS_PER_DAY: 20, // Events per day in timeline
  MAX_EVENT_TIMELINE_DAYS: 30, // Full 30-day game timeline

  // Post limits - extensive history for context and anti-repetition
  MAX_POST_CONTENT_LENGTH: 200, // ~50 tokens
  MAX_POSTS_PREVIOUS: 25, // Previous posts by NPC - larger for anti-repetition
  MAX_POSTS_RECENT: 150, // Recent feed posts summary
  MAX_POSTS_PER_ACTOR: 30, // Posts per actor in character context

  // Question limits - full question history for continuity
  MAX_QUESTION_TEXT_LENGTH: 250, // ~63 tokens
  MAX_QUESTIONS_RELATED: 10, // Related questions per NPC
  MAX_QUESTIONS_RESOLVED: 50, // Resolved questions in game context
  MAX_QUESTIONS_ACTIVE: 30, // Active questions in game context

  // Narrative limits - richer narrative tracking
  MAX_NARRATIVE_THREADS: 20, // Ongoing narrative threads
  MAX_ACTORS_PER_NARRATIVE: 8, // Actors per narrative thread
  MAX_QUESTIONS_PER_NARRATIVE: 10, // Questions per narrative thread

  // Character context limits - fuller character histories
  MAX_CHARACTER_EVENTS: 40, // Personal events in character context
  MAX_CHARACTER_POSTS: 30, // Personal posts in character context

  // Section limits - larger sections for rich context
  MAX_SECTION_LENGTH: 15000, // Max characters per section (~3750 tokens)
  MAX_TOTAL_CONTEXT_LENGTH: 320000, // Max total context (~80k tokens, ~60% of 128k)

  // Actor limits
  MAX_ACTORS_PER_EVENT: 5, // Actors listed per event - more for relationships

  // Day summary limits for narrative continuity
  MAX_DAY_SUMMARIES: 30, // Full game history
  MAX_DAY_SUMMARY_LENGTH: 500, // ~125 tokens per day summary

  // Resolved question detail limits
  MAX_RESOLUTION_EVENT_LENGTH: 400, // ~100 tokens for resolution events

  // Character roster limits - for full character context
  MAX_CHARACTERS_IN_ROSTER: 50, // Max characters in brief roster
  MAX_DETAILED_PROFILES: 15, // Max detailed character profiles
  MAX_RELATIONSHIPS_PER_CHARACTER: 10, // Relationships per character profile
  MAX_PROFILE_LENGTH: 800, // ~200 tokens per detailed profile
  MAX_ROSTER_LENGTH: 8000, // ~2000 tokens for brief roster

  // Organization limits
  MAX_ORGANIZATIONS: 30, // Max organizations in roster
  MAX_ORG_DESCRIPTION_LENGTH: 200, // ~50 tokens per org
} as const;

/**
 * Truncate text to a maximum length with ellipsis
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Truncate array to maximum length
 */
export function truncateArray<T>(array: T[], maxLength: number): T[] {
  return array.slice(0, maxLength);
}

/**
 * Estimate token count from character count (rough approximation: 1 token ≈ 4 chars)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Check if context size is within safe limits
 */
export function isContextSizeSafe(contextText: string): boolean {
  const estimatedTokens = estimateTokens(contextText);
  return estimatedTokens < CONTEXT_LIMITS.MAX_TOTAL_CONTEXT_LENGTH / 4; // ~80k tokens
}
