import {
  WalletDisplayScore,
  WalletDisplaySummary,
  WalletExposureSummary,
  WalletRiskSummary,
  WalletTrustSummary,
  WalletWhaleSummary,
} from "../types";

function toDisplayScore(
  rawScore: number,
  label: string,
): WalletDisplayScore {
  const safeScore = Math.max(0, Math.min(100, rawScore));
  const scoreOutOfTen = (safeScore / 10).toFixed(1);

  return {
    rawScore: safeScore,
    displayScore: `${scoreOutOfTen} / 10`,
    label,
    maxScore: 10,
  };
}

export function analyzeWalletDisplayScores(
  risk: WalletRiskSummary,
  trust: WalletTrustSummary,
  exposure: WalletExposureSummary,
  whale: WalletWhaleSummary,
): WalletDisplaySummary {
  return {
    risk: toDisplayScore(risk.score, risk.level),
    trust: toDisplayScore(trust.trustScore, trust.trustLevel.replace(/_/g, " ")),
    exposure: toDisplayScore(exposure.exposureScore, exposure.exposureLevel),
    whale: toDisplayScore(whale.whaleScore, whale.whaleLevel),
  };
}
