import { useFeed } from "./useFeed";

interface UseNarrativeFeedOptions {
  enabled?: boolean;
}

const NARRATIVE_CONFIG = {
  endpoint: "/api/feed/narrative",
  requiresAuth: false,
  logContext: "useNarrativeFeed",
  feedName: "Narrative",
} as const;

/**
 * Hook for fetching the narrative feed — story-grouped posts ranked by
 * engagement, recency, arc state, and resolution proximity.
 *
 * Refresh strategy (in priority order):
 * 1. SSE `feed` channel event → debounced 2 s refresh (real-time)
 * 2. Pull-to-refresh via `refresh()` (user-initiated)
 * 3. 5-minute fallback interval (SSE down / unauthenticated)
 */
export function useNarrativeFeed(options: UseNarrativeFeedOptions = {}) {
  return useFeed(NARRATIVE_CONFIG, options);
}
