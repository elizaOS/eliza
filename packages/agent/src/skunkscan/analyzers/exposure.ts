import { lookupStaticSolanaExposure } from "../exposure/staticRegistry";
import {
  WalletExposureSummary,
  WalletFundingSummary,
} from "../types";
import {
  buildConfidenceInput,
  confidenceLevelFromScore,
} from "../confidence/framework";

export function analyzeWalletExposure(
  walletAddress: string,
  funding: WalletFundingSummary,
): WalletExposureSummary {
  const matches: WalletExposureSummary["matches"] = [];

  const selfMatch = lookupStaticSolanaExposure(walletAddress);

  if (selfMatch) {
    matches.push({
      ...selfMatch,
      relationship: "self",
    });
  }

  if (funding.fundingWallet) {
    const fundingMatch = lookupStaticSolanaExposure(
      funding.fundingWallet,
    );

    if (fundingMatch) {
      matches.push({
        ...fundingMatch,
        relationship: "funder",
      });
    }
  }

  const hasKnownScamExposure = matches.some(
    (m) => m.category === "scam",
  );

  const hasKnownRugPullExposure = matches.some(
    (m) => m.category === "rug_pull",
  );

  const hasKnownSuspiciousExposure = matches.some(
    (m) =>
      m.category === "suspicious" ||
      m.category === "sanctioned" ||
      m.category === "adverse_media",
  );

  let exposureScore = 0;

  if (hasKnownScamExposure) {
    exposureScore += 50;
  }

  if (hasKnownRugPullExposure) {
    exposureScore += 30;
  }

  if (hasKnownSuspiciousExposure) {
    exposureScore += 20;
  }

  const exposureLevel =
    exposureScore >= 60
      ? "high"
      : exposureScore >= 30
        ? "medium"
        : exposureScore > 0
          ? "low"
          : "none";

  const evidenceConfidenceInput = buildConfidenceInput([
    {
      condition: Boolean(walletAddress),
      score: 30,
      reason: "Investigated wallet address was available.",
    },
    {
      condition: funding.evidenceConfidence === "high",
      score: 30,
      reason: "Funding evidence confidence is high.",
    },
    {
      condition: funding.evidenceConfidence === "medium",
      score: 20,
      reason: "Funding evidence confidence is medium.",
    },
    {
      condition: true,
      score: 25,
      reason: "Static exposure registry was checked.",
    },
    {
      condition: matches.length > 0,
      score: 15,
      reason: "Exposure match was identified.",
    },
  ]);

  const confidence =
    matches.length > 0
      ? confidenceLevelFromScore(evidenceConfidenceInput.score)
      : "medium";

  const notes =
    matches.length === 0
      ? [
          "No known exposure was identified using the current exposure registry.",
        ]
      : [
          "Exposure assessment is based on known registry matches.",
        ];

  return {
    exposureScore,
    exposureLevel,
    evidenceConfidence: confidenceLevelFromScore(
      evidenceConfidenceInput.score,
    ),
    confidence,
    hasKnownScamExposure,
    hasKnownRugPullExposure,
    hasKnownSuspiciousExposure,
    matches,
    notes,
  };
}
