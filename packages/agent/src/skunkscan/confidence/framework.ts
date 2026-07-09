export type ConfidenceLevel = "low" | "medium" | "high";

export type ConfidenceInput = {
  score: number;
  reasons: string[];
};

export function clampConfidenceScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

export function confidenceLevelFromScore(
  score: number,
): ConfidenceLevel {
  const safeScore = clampConfidenceScore(score);

  if (safeScore >= 75) {
    return "high";
  }

  if (safeScore >= 40) {
    return "medium";
  }

  return "low";
}

export function buildConfidenceInput(
  items: {
    condition: boolean;
    score: number;
    reason: string;
  }[],
): ConfidenceInput {
  let score = 0;
  const reasons: string[] = [];

  for (const item of items) {
    if (item.condition) {
      score += item.score;
      reasons.push(item.reason);
    }
  }

  return {
    score: clampConfidenceScore(score),
    reasons,
  };
}
