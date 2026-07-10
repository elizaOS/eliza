export type ConfidenceLevel = "low" | "medium" | "high";

export type ConfidenceInput = {
  score: number;
  reasons: string[];
};

export type ConfidenceAnalysis = {
  score: number;
  level: ConfidenceLevel;
  reasons: string[];
};

export type ConfidenceResponse = {
  rawScore: number;
  maxScore: 100;
  displayScore: string;
  maxDisplayScore: 10;
  level: ConfidenceLevel;
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

export function buildConfidenceAnalysis(
  items: {
    condition: boolean;
    score: number;
    reason: string;
  }[],
): ConfidenceAnalysis {
  const input = buildConfidenceInput(items);

  return {
    score: input.score,
    level: confidenceLevelFromScore(input.score),
    reasons: input.reasons,
  };
}

export function createConfidenceResponse(
  items: {
    condition: boolean;
    score: number;
    reason: string;
  }[],
): ConfidenceResponse {
  const analysis = buildConfidenceAnalysis(items);

  return {
    rawScore: analysis.score,
    maxScore: 100,
    displayScore: `${(analysis.score / 10).toFixed(1)} / 10`,
    maxDisplayScore: 10,
    level: analysis.level,
    reasons: analysis.reasons,
  };
}
