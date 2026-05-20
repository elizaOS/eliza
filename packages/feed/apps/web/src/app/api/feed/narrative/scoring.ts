import type { ArcStateType } from "@feed/shared";

// Scoring weights
const ENGAGEMENT_WEIGHT = 0.5;
const RECENCY_WEIGHT = 0.35;
const ACTIVITY_WEIGHT = 0.15;
const RECENCY_HALF_LIFE_HOURS = 12;

// Engagement weights
const LIKE_WEIGHT = 1;
const COMMENT_WEIGHT = 2;
const SHARE_WEIGHT = 3;

export function calculateTotalEngagement(
  likes: number,
  comments: number,
  shares: number,
): number {
  return (
    likes * LIKE_WEIGHT + comments * COMMENT_WEIGHT + shares * SHARE_WEIGHT
  );
}

export function calculateRecencyScore(newest: Date): number {
  const hoursOld = (Date.now() - newest.getTime()) / (1000 * 60 * 60);
  return Math.exp((-Math.LN2 * hoursOld) / RECENCY_HALF_LIFE_HOURS);
}

export function calculateActivityBonus(postCount: number): number {
  return Math.min(postCount / 10, 1);
}

export function calculateStoryScore(
  likes: number,
  comments: number,
  shares: number,
  postCount: number,
  newest: Date,
): number {
  return (
    calculateTotalEngagement(likes, comments, shares) * ENGAGEMENT_WEIGHT +
    calculateRecencyScore(newest) * RECENCY_WEIGHT +
    calculateActivityBonus(postCount) * ACTIVITY_WEIGHT
  );
}

/**
 * Arc state multiplier — boosts stories at dramatic narrative phases.
 * Uses the ArcState table's currentState field from the narrative engine.
 */
export function calculateArcStateMultiplier(
  arcState: ArcStateType | null,
): number {
  switch (arcState) {
    case "crisis":
      return 1.4;
    case "revelation":
      return 1.3;
    case "climax":
      return 1.35;
    case "escalation":
      return 1.15;
    case "active":
    case "live":
      return 1.1;
    case "tension":
      return 1.05;
    case "resolving":
      return 0.9;
    case "resolution":
      return 0.85;
    default:
      // 'setup', 'morning', 'midday', 'afternoon', 'evening', null
      return 1.0;
  }
}

/**
 * Resolution proximity boost — urgency multiplier for stories nearing resolution.
 * Questions resolving soon have peak uncertainty and reader interest.
 */
export function calculateResolutionBoost(resolutionDate: Date): number {
  const hoursUntil = (resolutionDate.getTime() - Date.now()) / (1000 * 60 * 60);
  if (hoursUntil <= 0) return 1.0; // already resolved/expired
  if (hoursUntil <= 6) return 1.4;
  if (hoursUntil <= 24) return 1.25;
  if (hoursUntil <= 72) return 1.1;
  return 1.0;
}
