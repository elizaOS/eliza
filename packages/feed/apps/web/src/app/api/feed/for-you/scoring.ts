import type { NarrativeStory } from "@feed/shared";

const AUTHOR_REPEAT_PENALTY = 0.55;
const CLUSTER_REPEAT_PENALTY = 0.8;
const MARKET_WINDOW_PENALTY = 0.5;
const MARKET_WINDOW_SIZE = 5;
const MAX_SCAN_AHEAD = 12;

export interface ForYouScoreInput {
  baseScore: number;
  topicMatchScore: number;
  socialAffinityScore: number;
  marketRelevanceScore: number;
  engagementVelocityScore: number;
  conversationDepthScore: number;
  narrativeUrgencyScore: number;
  freshnessScore: number;
  noveltyScore: number;
  retentionScore?: number;
  fatiguePenalty?: number;
  explorationBonus?: number;
}

export function calculateVelocityScore(
  engagementTotal: number,
  newest: Date,
): number {
  const ageHours = Math.max(
    (Date.now() - newest.getTime()) / (1000 * 60 * 60),
    0,
  );
  return Math.log1p(engagementTotal) / Math.sqrt(ageHours + 1);
}

export function calculateConversationDepthScore(
  commentCount: number,
  uniqueAuthors: number,
): number {
  return Math.log1p(commentCount * 1.5 + uniqueAuthors);
}

export function calculateFreshnessScore(newest: Date): number {
  const ageHours = Math.max(
    (Date.now() - newest.getTime()) / (1000 * 60 * 60),
    0,
  );
  return Math.exp((-Math.LN2 * ageHours) / 10);
}

const SCORE_WEIGHTS = {
  baseScore: 0.24,
  topicMatch: 0.2,
  socialAffinity: 0.14,
  marketRelevance: 0.16,
  engagementVelocity: 0.1,
  conversationDepth: 0.06,
  narrativeUrgency: 0.05,
  freshness: 0.03,
  novelty: 0.02,
  retention: 0.07,
  exploration: 0.03,
  fatiguePenalty: 0.18,
} as const;

export function calculateForYouScore(input: ForYouScoreInput): number {
  const normalizedBase = Math.log1p(Math.max(input.baseScore, 0));
  const retentionScore = input.retentionScore ?? 0;
  const fatiguePenalty = input.fatiguePenalty ?? 0;
  const explorationBonus = input.explorationBonus ?? 0;

  return (
    normalizedBase * SCORE_WEIGHTS.baseScore +
    input.topicMatchScore * SCORE_WEIGHTS.topicMatch +
    input.socialAffinityScore * SCORE_WEIGHTS.socialAffinity +
    input.marketRelevanceScore * SCORE_WEIGHTS.marketRelevance +
    input.engagementVelocityScore * SCORE_WEIGHTS.engagementVelocity +
    input.conversationDepthScore * SCORE_WEIGHTS.conversationDepth +
    input.narrativeUrgencyScore * SCORE_WEIGHTS.narrativeUrgency +
    input.freshnessScore * SCORE_WEIGHTS.freshness +
    input.noveltyScore * SCORE_WEIGHTS.novelty +
    retentionScore * SCORE_WEIGHTS.retention +
    explorationBonus * SCORE_WEIGHTS.exploration -
    fatiguePenalty * SCORE_WEIGHTS.fatiguePenalty
  );
}

function getPrimaryAuthorId(story: NarrativeStory): string | null {
  return story.primaryAuthorId ?? story.posts[0]?.authorId ?? null;
}

function getClusterId(story: NarrativeStory): string {
  return story.clusterId ?? story.storyKey;
}

export function diversifyForYouStories(
  rankedStories: NarrativeStory[],
): NarrativeStory[] {
  const remaining = [...rankedStories];
  const result: NarrativeStory[] = [];
  const recentAuthorIds: string[] = [];
  const recentClusterIds: string[] = [];
  let recentMarketCards = 0;

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    const scanLimit = Math.min(remaining.length, MAX_SCAN_AHEAD);

    for (let index = 0; index < scanLimit; index++) {
      const story = remaining[index]!;
      let adjustedScore = story.finalRankScore ?? story.storyScore;
      const authorId = getPrimaryAuthorId(story);
      const clusterId = getClusterId(story);

      if (authorId && recentAuthorIds.includes(authorId)) {
        adjustedScore -= AUTHOR_REPEAT_PENALTY;
      }

      if (recentClusterIds.includes(clusterId)) {
        adjustedScore -= CLUSTER_REPEAT_PENALTY;
      }

      if (story.isNewMarket && recentMarketCards >= 1) {
        adjustedScore -= MARKET_WINDOW_PENALTY;
      }

      if (adjustedScore > bestScore) {
        bestScore = adjustedScore;
        bestIndex = index;
      }
    }

    const [selected] = remaining.splice(bestIndex, 1);
    if (!selected) break;

    result.push(selected);

    const authorId = getPrimaryAuthorId(selected);
    if (authorId) {
      recentAuthorIds.unshift(authorId);
      if (recentAuthorIds.length > 3) recentAuthorIds.pop();
    }

    recentClusterIds.unshift(getClusterId(selected));
    if (recentClusterIds.length > 3) recentClusterIds.pop();

    recentMarketCards = result
      .slice(-MARKET_WINDOW_SIZE)
      .filter((story) => story.isNewMarket).length;
  }

  return result;
}

/**
 * Guarantee at least one article every ARTICLE_MAX_GAP items.
 * Uses a single forward pass: collect article positions first, then
 * rebuild the array once — O(n) instead of O(n²) splice-in-loop.
 */
const ARTICLE_MAX_GAP = 40;

function isArticleStory(story: NarrativeStory): boolean {
  return story.itemType === "article" || story.posts[0]?.type === "article";
}

export function ensureArticleSpacing(
  stories: NarrativeStory[],
): NarrativeStory[] {
  if (stories.length === 0) return stories;

  // Collect indices of all articles in original order
  const articleIndices: number[] = [];
  for (let i = 0; i < stories.length; i++) {
    if (isArticleStory(stories[i]!)) articleIndices.push(i);
  }
  if (articleIndices.length === 0) return [...stories];

  // Determine which articles need to be pulled forward and to where
  const pulled = new Set<number>(); // original indices consumed early
  const insertions: Array<{ before: number; fromIndex: number }> = [];
  let lastArticlePos = -1;
  let nextArticlePtr = 0; // pointer into articleIndices

  for (let i = 0; i < stories.length; i++) {
    if (isArticleStory(stories[i]!)) {
      lastArticlePos = i;
      // advance pointer past any articles at or before i
      while (
        nextArticlePtr < articleIndices.length &&
        articleIndices[nextArticlePtr]! <= i
      ) {
        nextArticlePtr++;
      }
      continue;
    }

    if (i - lastArticlePos >= ARTICLE_MAX_GAP) {
      // Find next unpulled article after current position
      while (
        nextArticlePtr < articleIndices.length &&
        pulled.has(articleIndices[nextArticlePtr]!)
      ) {
        nextArticlePtr++;
      }
      if (nextArticlePtr < articleIndices.length) {
        const srcIdx = articleIndices[nextArticlePtr]!;
        pulled.add(srcIdx);
        insertions.push({ before: i, fromIndex: srcIdx });
        lastArticlePos = i; // this position will hold the article
        nextArticlePtr++;
      }
    }
  }

  if (insertions.length === 0) return [...stories];

  // Build result: walk original array, inserting pulled articles at their targets
  const result: NarrativeStory[] = [];
  let insPtr = 0;
  for (let i = 0; i < stories.length; i++) {
    // Insert any articles scheduled before this index
    while (insPtr < insertions.length && insertions[insPtr]?.before === i) {
      result.push(stories[insertions[insPtr]?.fromIndex]!);
      insPtr++;
    }
    // Skip items that were pulled forward
    if (pulled.has(i)) continue;
    result.push(stories[i]!);
  }
  return result;
}

/**
 * Hard-guarantee pass that ensures no two market cards are adjacent in the feed.
 * Applied after `diversifyForYouStories()`, which uses score-based penalties that
 * can fail to separate markets when score gaps are large. This function provides
 * an unconditional structural guarantee with minimal rank-order disturbance.
 *
 * When two consecutive isNewMarket items are found, the nearest following
 * non-market story is spliced between them.
 */
export function spreadNewMarkets(stories: NarrativeStory[]): NarrativeStory[] {
  const result = [...stories];

  for (let i = 0; i < result.length - 1; i++) {
    const current = result[i];
    const next = result[i + 1];
    if (!current?.isNewMarket) continue;
    if (!next?.isNewMarket) continue;

    // Two consecutive markets at i and i+1 — find the next non-market after i+1
    const nextPostIdx = result.findIndex(
      (s, idx) => idx > i + 1 && !s.isNewMarket,
    );

    if (nextPostIdx !== -1) {
      // Pull the non-market post forward to sit between the two markets
      const post = result.splice(nextPostIdx, 1)[0];
      if (post !== undefined) {
        result.splice(i + 1, 0, post);
      }
    }
    // Edge case: all remaining items are markets — leave as-is
  }

  return result;
}
