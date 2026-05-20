import type { NarrativeStory } from '@feed/shared';

/**
 * Cursor encoding for score-ranked feeds (For You, Stories).
 *
 * Feeds are ranked by score (not timestamp), so the cursor encodes position
 * in the ranked array using a composite {score, storyKey} pair. This mirrors
 * the cursor-based pagination used by Twitter/X, TikTok, and similar feeds.
 *
 * The storyKey tiebreaker guarantees deterministic ordering even when multiple
 * stories share the same score.
 */

interface FeedCursor {
  /** Score at cursor position */
  s: number;
  /** StoryKey tiebreaker for stable ordering */
  k: string;
}

/**
 * Encode a cursor from the last story in a page.
 * Returns a base64url-encoded JSON string.
 */
export function encodeCursor(score: number, storyKey: string): string {
  const cursor: FeedCursor = { s: score, k: storyKey };
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/**
 * Decode a cursor string back to {score, storyKey}.
 * Returns null if the cursor is malformed.
 */
export function decodeCursor(encoded: string): FeedCursor | null {
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (typeof parsed.s !== 'number' || typeof parsed.k !== 'string') {
      return null;
    }
    return { s: parsed.s, k: parsed.k };
  } catch {
    return null;
  }
}

/**
 * Find the start index in a ranked stories array given a cursor.
 *
 * Stories are sorted descending by score. The cursor marks the last item the
 * client received. We find the first item that comes AFTER the cursor position:
 * - score < cursor.s, OR
 * - score === cursor.s AND storyKey > cursor.k (lexicographic tiebreaker)
 *
 * Uses binary search for O(log n) performance on large arrays.
 */
export function findCursorIndex(
  stories: NarrativeStory[],
  cursor: FeedCursor
): number {
  let lo = 0;
  let hi = stories.length;

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // mid is always in [lo, hi) which is within [0, stories.length), safe to index
    const story = stories[mid]!;
    const score = story.finalRankScore ?? story.storyScore;

    if (
      score > cursor.s ||
      (score === cursor.s && story.storyKey <= cursor.k)
    ) {
      // This item is at or before the cursor position — look further right
      lo = mid + 1;
    } else {
      // This item is after the cursor position — might be our answer
      hi = mid;
    }
  }

  return lo;
}

export function compareFeedStories(
  left: NarrativeStory,
  right: NarrativeStory
): number {
  const leftScore = left.finalRankScore ?? left.storyScore;
  const rightScore = right.finalRankScore ?? right.storyScore;

  if (leftScore !== rightScore) {
    return rightScore - leftScore;
  }

  return left.storyKey.localeCompare(right.storyKey);
}
