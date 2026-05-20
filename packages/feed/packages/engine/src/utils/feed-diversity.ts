/**
 * Feed Diversity Utilities
 *
 * TikTok-inspired mechanisms for preventing action clustering and creating
 * organic social media feed patterns.
 *
 * Exports:
 * - shuffleWithNoConsecutive: Fisher-Yates shuffle with no-consecutive constraint
 * - createDiscourseActionDeck: Stratified action deck for quote/reply ratios
 * - ActionDiversityTracker: Tracks recent actions to prevent clustering
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Action types tracked by the diversity system for social engagement.
 */
export type EngagementActionType = 'like' | 'share' | 'comment';

/**
 * Action types for discourse generation (quotes vs replies).
 */
export type DiscourseActionType = 'quote' | 'reply';

// =============================================================================
// SHUFFLE WITH NO CONSECUTIVE
// =============================================================================

/**
 * Fisher-Yates shuffle with constraint: no consecutive same values.
 * This is the core mechanism that prevents action clustering.
 *
 * Algorithm:
 * 1. Build result array one element at a time
 * 2. For each position, find candidates that differ from the last selected item
 * 3. Apply safety check: only pick candidates whose removal keeps a valid ordering possible
 * 4. Pick randomly from safe candidates (fall back to valid, then any if needed)
 *
 * Dead-end prevention: Before selecting a candidate, we verify that removing it
 * won't make the remaining items impossible to arrange without consecutive duplicates.
 * A valid arrangement requires maxCount <= ceil(length / 2).
 *
 * @param arr Array to shuffle
 * @param random RNG function
 */
export function shuffleWithNoConsecutive<T>(
  arr: T[],
  random: () => number
): T[] {
  if (arr.length <= 1) return [...arr];

  const result: T[] = [];
  const remaining = [...arr];

  // Track counts of each value for efficient dead-end detection
  const countByValue = new Map<T, number>();
  for (const item of remaining) {
    countByValue.set(item, (countByValue.get(item) ?? 0) + 1);
  }

  while (remaining.length > 0) {
    const lastItem = result[result.length - 1];

    // Find valid candidates (different from last item, or any if first pick)
    const validIndices: number[] = [];
    for (let i = 0; i < remaining.length; i++) {
      if (result.length === 0 || remaining[i] !== lastItem) {
        validIndices.push(i);
      }
    }

    // Filter to safe candidates: those whose removal keeps ordering possible
    // A valid non-consecutive ordering requires maxCount <= ceil(length / 2)
    const safeCandidates = validIndices.filter((idx) => {
      const value = remaining[idx];
      const newLength = remaining.length - 1;
      if (newLength === 0) return true; // Last item, always safe

      // Simulate removal: find max count after removing this value
      let maxCountAfter = 0;
      for (const [v, count] of countByValue) {
        const newCount = v === value ? count - 1 : count;
        if (newCount > maxCountAfter) maxCountAfter = newCount;
      }

      // Safe if max count <= ceil(newLength / 2)
      return maxCountAfter <= Math.ceil(newLength / 2);
    });

    // Use safe candidates if any, otherwise fall back to valid, then any
    const candidates =
      safeCandidates.length > 0
        ? safeCandidates
        : validIndices.length > 0
          ? validIndices
          : remaining.map((_, idx) => idx);

    // Pick random from candidates
    const pickIdx = candidates[Math.floor(random() * candidates.length)]!;
    const pickedValue = remaining[pickIdx]!;
    result.push(pickedValue);

    // Update counts and remaining array
    countByValue.set(pickedValue, (countByValue.get(pickedValue) ?? 1) - 1);
    remaining.splice(pickIdx, 1);
  }

  return result;
}

// =============================================================================
// DISCOURSE ACTION DECK
// =============================================================================

/**
 * Creates a stratified action deck with guaranteed ratios.
 * Inspired by TikTok (never 2 same in a row) and org-tick stratified selection.
 *
 * Instead of rolling `random() < probability` for each action (which can cluster),
 * we pre-define action slots with guaranteed ratios and shuffle with constraints.
 *
 * @param totalSlots Total actions to perform
 * @param quoteRatio Target ratio of quote posts (e.g., 0.30)
 * @param random RNG function for shuffling
 */
export function createDiscourseActionDeck(
  totalSlots: number,
  quoteRatio: number,
  random: () => number
): DiscourseActionType[] {
  if (totalSlots <= 0) return [];

  // Clamp quoteRatio to valid [0, 1] range to prevent negative/oversized counts
  const clampedRatio = Math.max(0, Math.min(1, quoteRatio));
  const quoteCount = Math.round(totalSlots * clampedRatio);
  const replyCount = totalSlots - quoteCount;

  // Build deck with exact ratios
  const deck: DiscourseActionType[] = [
    ...Array(quoteCount).fill('quote' as const),
    ...Array(replyCount).fill('reply' as const),
  ];

  // Shuffle with hard constraint: no 2 same in a row (TikTok rule)
  return shuffleWithNoConsecutive(deck, random);
}

// =============================================================================
// ACTION DIVERSITY TRACKER
// =============================================================================

/**
 * Tracks recent action types to prevent clustering.
 * Inspired by TikTok's "never 2 same in a row" rule.
 *
 * This tracker maintains a rolling buffer of recent actions and checks
 * whether adding a new action would create too many consecutive same types.
 *
 * NOTE: When shouldSkipForDiversity returns true, the action is skipped entirely.
 * This is intentional - we prioritize feed variety over raw engagement counts.
 * If metrics show significant drops, consider implementing action type fallback
 * (try different action when blocked for diversity).
 */
export class ActionDiversityTracker {
  private recentActions: EngagementActionType[] = [];
  private readonly maxRecent: number;
  private readonly maxConsecutive: number;

  /**
   * @param maxRecent Number of recent actions to track in the buffer
   * @param maxConsecutive Maximum consecutive same action type allowed
   */
  constructor(maxRecent = 5, maxConsecutive = 2) {
    // Ensure buffer can hold enough history to check consecutive actions
    this.maxRecent = Math.max(maxRecent, maxConsecutive);
    // Ensure maxConsecutive is at least 1
    this.maxConsecutive = Math.max(1, maxConsecutive);
  }

  /**
   * Record an action that was executed.
   */
  recordAction(type: EngagementActionType): void {
    this.recentActions.push(type);
    if (this.recentActions.length > this.maxRecent) {
      this.recentActions.shift();
    }
  }

  /**
   * Check if executing this action type would create too many consecutive same types.
   * Returns true if the action should be skipped/deferred for diversity.
   */
  shouldSkipForDiversity(type: EngagementActionType): boolean {
    const lastN = this.recentActions.slice(-this.maxConsecutive);
    return (
      lastN.length >= this.maxConsecutive && lastN.every((t) => t === type)
    );
  }

  /**
   * Get the distribution of recent actions for logging.
   */
  getDistribution(): Record<EngagementActionType, number> {
    const dist: Record<EngagementActionType, number> = {
      like: 0,
      share: 0,
      comment: 0,
    };
    for (const action of this.recentActions) {
      dist[action]++;
    }
    return dist;
  }
}
