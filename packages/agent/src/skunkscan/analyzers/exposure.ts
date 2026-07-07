import { lookupStaticSolanaExposure } from "../exposure/staticRegistry";
import {
  WalletExposureSummary,
  WalletFundingSummary,
} from "../types";

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
    hasKnownScamExposure,
    hasKnownRugPullExposure,
    hasKnownSuspiciousExposure,
    matches,
    notes,
  };
}
