import { lookupStaticExposure } from "../exposure/staticRegistry";
import {
  SupportedChain,
  WalletExposureSummary,
  WalletFundingSummary,
  WalletRelationship,
} from "../types";
import {
  createConfidenceResponse,
} from "../confidence/framework";

export function analyzeWalletExposure(
  walletAddress: string,
  funding: WalletFundingSummary,
  chain: SupportedChain,
  relationships: WalletRelationship[] = [],
): WalletExposureSummary {
  const matches: WalletExposureSummary["matches"] = [];

  const selfMatch = lookupStaticExposure(chain, walletAddress);

  if (selfMatch) {
    matches.push({
      ...selfMatch,
      relationship: "self",
      contributesToScore: true,
    });
  }

  if (funding.fundingWallet) {
    const fundingMatch = lookupStaticExposure(
      chain,
      funding.fundingWallet,
    );

    if (fundingMatch) {
      matches.push({
        ...fundingMatch,
        relationship: "funder",
        contributesToScore: true,
        direction: "incoming",
      });
    }
  }

  // Every relationship counterparty discovered by relationships.ts gets
  // checked too - not just self and the single funding wallet above. The
  // funder's own address is skipped here since it's already covered by the
  // dedicated check above; without this skip the same address could
  // produce two matches (once as "funder", once as "counterparty").
  for (const relationship of relationships) {
    if (relationship.address === funding.fundingWallet) {
      continue;
    }

    const counterpartyMatch = lookupStaticExposure(
      chain,
      relationship.address,
    );

    if (!counterpartyMatch) {
      continue;
    }

    const direction = relationship.direction ?? "unknown";

    matches.push({
      ...counterpartyMatch,
      relationship: "counterparty",
      // An incoming-only transfer from a flagged address (e.g. an
      // unsolicited spam-token airdrop) is not something the wallet owner
      // did - it's a materially weaker signal than the wallet itself
      // sending funds to, or exchanging funds with, a flagged address, so
      // it's shown for visibility but doesn't move the score.
      contributesToScore:
        direction === "outgoing" || direction === "bidirectional",
      direction,
      transactionSignatures: relationship.transactionSignatures,
    });
  }

  const scoringEligibleMatches = matches.filter(
    (match) => match.contributesToScore,
  );

  const hasKnownScamExposure = scoringEligibleMatches.some(
    (match) => match.category === "scam",
  );

  const hasKnownRugPullExposure = scoringEligibleMatches.some(
    (match) => match.category === "rug_pull",
  );

  const hasKnownSuspiciousExposure = scoringEligibleMatches.some(
    (match) =>
      match.category === "suspicious" ||
      match.category === "sanctioned" ||
      match.category === "adverse_media",
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

  const confidenceAnalysis = createConfidenceResponse([
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
      ? confidenceAnalysis.level
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
    evidenceConfidence: confidenceAnalysis.level,
    confidenceAnalysis,
    confidence,
    hasKnownScamExposure,
    hasKnownRugPullExposure,
    hasKnownSuspiciousExposure,
    matches,
    notes,
  };
}
