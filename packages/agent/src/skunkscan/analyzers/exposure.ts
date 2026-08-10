import { lookupStaticExposure } from "../exposure/staticRegistry";
import {
  getRegistryAddressScanCoverage,
  lookupReverseExposureIndex,
} from "../exposure/reverseIndex";
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
  // Accepts a single address (every existing caller - Ethereum/Solana/BSC/
  // Base each investigate exactly one address) or a readonly array (Bitcoin
  // xpub wallets - a worst-case rollup across every derived address, same
  // as this function's own existing single-address dedup-by-flagged-address
  // logic, just widened to check N addresses instead of 1). Single-string
  // behavior is 100% unchanged - normalizing to an array immediately below
  // means a one-element array and a bare string produce identical matches.
  walletAddress: string | readonly string[],
  funding: WalletFundingSummary,
  chain: SupportedChain,
  relationships: WalletRelationship[] = [],
): WalletExposureSummary {
  const walletAddresses =
    typeof walletAddress === "string" ? [walletAddress] : walletAddress;

  const matches: WalletExposureSummary["matches"] = [];

  // Dedup key: which flagged registry addresses have already produced a
  // match, regardless of which check (self/funder/reverse-index/live
  // counterparty) found them - every match's own `address` field is the
  // flagged address itself (carried over from the registry entry via
  // spread), so this is the right key across all four sources.
  const matchedFlaggedAddresses = new Set<string>();

  for (const address of walletAddresses) {
    const selfMatch = lookupStaticExposure(chain, address);

    if (selfMatch && !matchedFlaggedAddresses.has(selfMatch.address)) {
      matches.push({
        ...selfMatch,
        relationship: "self",
        contributesToScore: true,
      });
      matchedFlaggedAddresses.add(selfMatch.address);
    }
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
      matchedFlaggedAddresses.add(fundingMatch.address);
    }
  }

  // Reverse-index check: an O(1) lookup of "every flagged address this
  // wallet has ever transacted with," precomputed by periodically
  // scanning the (small, fixed) set of flagged registry addresses' own
  // transaction history (see exposure/buildReverseIndex.ts). This gives
  // exposure coverage independent of the wallet's own sample depth - it
  // doesn't depend on `relationships` at all.
  const partiallyScannedMatchLabels: string[] = [];

  for (const address of walletAddresses) {
    const reverseIndexEntry = lookupReverseExposureIndex(chain, address);

    if (!reverseIndexEntry) {
      continue;
    }

    for (const reverseMatch of reverseIndexEntry.matches) {
      if (matchedFlaggedAddresses.has(reverseMatch.flaggedAddress)) {
        continue;
      }

      const registryEntry = lookupStaticExposure(
        chain,
        reverseMatch.flaggedAddress,
      );

      if (!registryEntry) {
        continue;
      }

      matches.push({
        ...registryEntry,
        relationship: "counterparty",
        source: "reverse_index",
        contributesToScore: reverseMatch.contributesToScore,
        direction: reverseMatch.direction,
        transactionSignatures: reverseMatch.transactionSignatures,
      });
      matchedFlaggedAddresses.add(registryEntry.address);

      const coverage = getRegistryAddressScanCoverage(
        chain,
        reverseMatch.flaggedAddress,
      );

      // A "failed" source (zero transactions ever scanned) can never
      // produce a match by construction - only "capped" (real partial
      // data, more may exist beyond what's indexed) is relevant here.
      if (coverage?.status === "capped") {
        partiallyScannedMatchLabels.push(registryEntry.label);
      }
    }
  }

  // Every relationship counterparty discovered by relationships.ts gets
  // checked too - not just self, the funding wallet, and the reverse
  // index above. Anything already matched by one of those is skipped, so
  // the same flagged address never produces two entries in `matches`.
  for (const relationship of relationships) {
    if (matchedFlaggedAddresses.has(relationship.address)) {
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
    matchedFlaggedAddresses.add(counterpartyMatch.address);
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
      condition: walletAddresses.length > 0,
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

  // Distinct labels only, in case a single flagged address somehow
  // contributed more than once (shouldn't happen given the dedup above,
  // but this keeps the note honest either way).
  const distinctPartiallyScannedLabels = Array.from(
    new Set(partiallyScannedMatchLabels),
  );

  if (distinctPartiallyScannedLabels.length === 1) {
    notes.push(
      `The match against ${distinctPartiallyScannedLabels[0]} reflects a partial scan of that address's own transaction history - more matching activity may exist beyond what's been indexed so far.`,
    );
  } else if (distinctPartiallyScannedLabels.length > 1) {
    const labelList = `${distinctPartiallyScannedLabels.slice(0, -1).join(", ")} and ${distinctPartiallyScannedLabels[distinctPartiallyScannedLabels.length - 1]}`;

    notes.push(
      `Matches against ${labelList} reflect partial scans of those addresses' own transaction history - more matching activity may exist beyond what's been indexed so far.`,
    );
  }

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
