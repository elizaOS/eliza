/**
 * Content Analysis Utilities
 *
 * Analyzes post content to derive sentiment, certainty, and other metrics
 * WITHOUT exposing oracle data. All analysis is from observable text patterns.
 *
 * Safe for competitive MMO - based on NLP, not ground truth.
 */

/**
 * Analyze certainty level in content
 *
 * Detects certainty markers (definitely, confirmed) and hedging words
 * (maybe, possibly) to determine how certain the content sounds.
 *
 * @param content - Text content to analyze
 * @returns Certainty score between 0 (uncertain) and 1 (certain)
 *
 * @example
 * ```typescript
 * analyzeCertainty("This is definitely happening"); // ~0.6 (high certainty)
 * analyzeCertainty("Maybe this could happen"); // ~0.3 (low certainty)
 * ```
 */
export function analyzeCertainty(content: string): number {
  const text = content.toLowerCase();

  // Certainty markers (increase score):
  const certaintyWords = [
    "definitely",
    "certainly",
    "confirmed",
    "confirm",
    "absolute",
    "guaranteed",
    "sure",
    "certain",
    "undoubtedly",
    "clearly",
    "obviously",
    "proven",
    "verified",
    "established",
    "conclusive",
  ];

  // Hedging markers (decrease score):
  const hedgingWords = [
    "maybe",
    "possibly",
    "perhaps",
    "might",
    "could",
    "probably",
    "likely",
    "potentially",
    "seems",
    "appears",
    "suggests",
    "unclear",
    "uncertain",
    "unsure",
    "questionable",
    "doubtful",
  ];

  let certaintyScore = 0.5; // Neutral baseline

  certaintyWords.forEach((word) => {
    if (text.includes(word)) certaintyScore += 0.1;
  });

  hedgingWords.forEach((word) => {
    if (text.includes(word)) certaintyScore -= 0.1;
  });

  // Clamp to 0-1:
  return Math.max(0, Math.min(1, certaintyScore));
}

/**
 * Detect insider language patterns
 *
 * Checks for phrases that suggest insider knowledge or confidential sources.
 *
 * @param content - Post content to analyze
 * @returns True if content contains insider language patterns
 *
 * @example
 * ```typescript
 * hasInsiderLanguage("My sources say this will happen"); // true
 * hasInsiderLanguage("This is public information"); // false
 * ```
 */
export function hasInsiderLanguage(content: string): boolean {
  const text = content.toLowerCase();

  const insiderPhrases = [
    "my sources",
    "sources say",
    "sources tell me",
    "sources confirm",
    "heard from",
    "insider",
    "confidential",
    "off the record",
    "between us",
    "not public yet",
    "won't be announced",
    "internal",
    "private meeting",
    "leaked",
    "just learned",
  ];

  return insiderPhrases.some((phrase) => text.includes(phrase));
}

/**
 * Analyze sentiment from text
 *
 * Uses keyword matching to detect positive and negative sentiment.
 * Returns score between -1 (negative) and 1 (positive).
 *
 * @param content - Post content to analyze
 * @returns Sentiment score between -1 (negative) and 1 (positive)
 *
 * @example
 * ```typescript
 * analyzeSentiment("This is great news!"); // ~0.3 (positive)
 * analyzeSentiment("This is terrible"); // ~-0.3 (negative)
 * ```
 */
export function analyzeSentiment(content: string): number {
  const text = content.toLowerCase();

  // Positive words:
  const positiveWords = [
    "great",
    "good",
    "excellent",
    "success",
    "win",
    "approved",
    "confirmed",
    "breakthrough",
    "amazing",
    "fantastic",
    "bullish",
    "optimistic",
    "positive",
    "growth",
    "profit",
    "surge",
  ];

  // Negative words:
  const negativeWords = [
    "bad",
    "terrible",
    "failure",
    "fail",
    "loss",
    "rejected",
    "denied",
    "crash",
    "collapse",
    "bearish",
    "pessimistic",
    "negative",
    "decline",
    "drop",
    "concern",
    "worry",
    "risk",
  ];

  let score = 0;

  positiveWords.forEach((word) => {
    if (text.includes(word)) score += 0.15;
  });

  negativeWords.forEach((word) => {
    if (text.includes(word)) score -= 0.15;
  });

  return Math.max(-1, Math.min(1, score));
}

/**
 * Calculate information freshness
 *
 * Determines how fresh/relevant a post is based on its age.
 * Older posts receive lower freshness scores.
 *
 * @param postDay - Day post was created (1-30)
 * @param currentDay - Current game day (1-30)
 * @returns Freshness score between 0.3 (very old) and 1.0 (fresh)
 *
 * @example
 * ```typescript
 * calculateFreshness(5, 10); // ~0.6 (5 days old)
 * calculateFreshness(10, 10); // 1.0 (current day)
 * ```
 */
export function calculateFreshness(
  postDay: number,
  currentDay: number,
): number {
  const age = currentDay - postDay;
  const freshness = Math.max(0.3, 1.0 - age * 0.08);
  return freshness;
}

/**
 * Composite content quality score (NO ORACLE DATA)
 *
 * Calculates post quality from OBSERVABLE and HISTORICAL data only.
 * Does NOT use oracle metadata (clueStrength, pointsToward).
 *
 * Combines:
 * - Content analysis (certainty, insider language): 0-40 points
 * - Source quality (historical accuracy): 0-30 points
 * - Role credibility: 0-15 points
 * - Freshness: 0-15 points
 *
 * @param content - Post content to analyze
 * @param authorRole - Author's public role (observable from profile)
 * @param postDay - Day post was created (optional)
 * @param currentDay - Current game day (optional)
 * @param historicalAccuracy - Author's past accuracy 0-1 (optional)
 * @returns Quality score between 0 and 100
 *
 * @example
 * ```typescript
 * const quality = calculateContentQuality(
 *   "My sources confirm this will happen",
 *   "insider",
 *   10,
 *   10,
 *   0.8
 * ); // Returns: ~85 (high quality)
 * ```
 */
export function calculateContentQuality(
  content: string,
  authorRole?: string | null,
  postDay?: number | null,
  currentDay?: number | null,
  historicalAccuracy?: number | null,
): number {
  // Component 1: Content analysis (0-40 points)
  const certainty = analyzeCertainty(content);
  const hasInsider = hasInsiderLanguage(content);
  const contentScore = certainty * 30 + (hasInsider ? 10 : 0);

  // Component 2: Source quality (0-30 points) - from historical accuracy
  const sourceScore = (historicalAccuracy ?? 0.5) * 30;

  // Component 3: Role credibility (0-15 points) - observable from profile
  const roleScore = getRoleBaseScore(authorRole);

  // Component 4: Freshness (0-15 points)
  const freshnessScore =
    postDay && currentDay ? calculateFreshness(postDay, currentDay) * 15 : 15; // Default to fresh if no day info

  return Math.round(contentScore + sourceScore + roleScore + freshnessScore);
}

/**
 * Get base quality score by role (observable from public profile)
 */
function getRoleBaseScore(role?: string | null): number {
  const roleScores: Record<string, number> = {
    insider: 15,
    executive: 14,
    expert: 12,
    journalist: 10,
    analyst: 9,
    supporting: 5,
    extra: 3,
  };

  return role ? (roleScores[role] ?? 5) : 5;
}

/**
 * Analyze if post makes a prediction
 *
 * Detects whether content makes a YES/NO prediction and determines
 * the direction and confidence level.
 *
 * @param content - Post content to analyze
 * @returns Object with prediction status, direction, and confidence
 *
 * @example
 * ```typescript
 * const result = detectPrediction("This will definitely happen");
 * // Returns: { makesPrediction: true, direction: 'YES', confidence: 0.6 }
 * ```
 */
export function detectPrediction(content: string): {
  makesPrediction: boolean;
  direction: "YES" | "NO" | "UNCLEAR";
  confidence: number;
} {
  const text = content.toLowerCase();

  // YES indicators:
  const yesIndicators = [
    "will happen",
    "will succeed",
    "will announce",
    "going to happen",
    "definitely yes",
    "absolutely",
    "for sure",
    "guaranteed",
  ];

  // NO indicators:
  const noIndicators = [
    "won't happen",
    "will fail",
    "won't announce",
    "not going to",
    "definitely not",
    "no way",
    "impossible",
    "won't succeed",
  ];

  const hasYes = yesIndicators.some((phrase) => text.includes(phrase));
  const hasNo = noIndicators.some((phrase) => text.includes(phrase));

  if (hasYes && !hasNo) {
    return {
      makesPrediction: true,
      direction: "YES",
      confidence: analyzeCertainty(content),
    };
  }
  if (hasNo && !hasYes) {
    return {
      makesPrediction: true,
      direction: "NO",
      confidence: analyzeCertainty(content),
    };
  }

  return {
    makesPrediction: false,
    direction: "UNCLEAR",
    confidence: 0,
  };
}
