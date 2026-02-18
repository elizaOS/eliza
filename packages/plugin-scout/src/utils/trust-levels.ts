import type { TrustLevel, Verdict } from "../client/types.js";

export interface TrustLevelInfo {
  level: TrustLevel;
  minScore: number;
  label: string;
  description: string;
}

export const TRUST_LEVELS: TrustLevelInfo[] = [
  { level: "HIGH", minScore: 75, label: "High Trust", description: "Safe for standard x402 transactions" },
  { level: "MEDIUM", minScore: 50, label: "Medium Trust", description: "Usable with caution for larger amounts" },
  { level: "LOW", minScore: 25, label: "Low Trust", description: "Caution - verify before transacting" },
  { level: "VERY_LOW", minScore: 0, label: "Very Low Trust", description: "Not recommended for any transactions" },
];

export function getTrustLevel(score: number): TrustLevelInfo {
  if (!Number.isFinite(score) || score < 0) return TRUST_LEVELS[TRUST_LEVELS.length - 1];
  const clamped = Math.min(score, 100);
  for (const level of TRUST_LEVELS) {
    if (clamped >= level.minScore) return level;
  }
  return TRUST_LEVELS[TRUST_LEVELS.length - 1];
}

export interface VerdictInfo {
  verdict: Verdict;
  minScore: number;
  maxTransaction: number;
  label: string;
}

export const VERDICTS: VerdictInfo[] = [
  { verdict: "RECOMMENDED", minScore: 75, maxTransaction: 5000, label: "Recommended" },
  { verdict: "USABLE", minScore: 50, maxTransaction: 1000, label: "Usable" },
  { verdict: "CAUTION", minScore: 25, maxTransaction: 100, label: "Caution" },
  { verdict: "NOT_RECOMMENDED", minScore: 0, maxTransaction: 0, label: "Not Recommended" },
];

export function getVerdict(score: number): VerdictInfo {
  if (!Number.isFinite(score) || score < 0) return VERDICTS[VERDICTS.length - 1];
  const clamped = Math.min(score, 100);
  for (const v of VERDICTS) {
    if (clamped >= v.minScore) return v;
  }
  return VERDICTS[VERDICTS.length - 1];
}

export function isScoreSafe(score: number, minScore: number): boolean {
  if (!Number.isFinite(score) || !Number.isFinite(minScore)) return false;
  return score >= minScore;
}