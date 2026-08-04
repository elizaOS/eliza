import { lookupWalletLabel } from "../labels/labelEngine";
import { SupportedChain, WalletRelationship } from "../types";
import { LabelMatchReference } from "../candidates/types";

/**
 * False-positive defense for candidate review: checks the flagged wallet
 * itself, plus every counterparty already surfaced in its relationships,
 * against the known-label registry. A hit here (especially
 * `centralized_exchange`) tells a reviewer "this is a known exchange
 * wallet" before they spend time investigating it as a scam candidate -
 * exactly the Binance-14-shaped false positive Pattern B would have
 * produced.
 *
 * `lookupWalletLabel` returns a synthetic "Unknown Wallet" / category
 * "unknown" fallback for anything not in the static registry - that
 * fallback does not count as a match here.
 */
export function checkKnownLabelMatches(
  chain: SupportedChain,
  walletAddress: string,
  relationships: WalletRelationship[],
): { hasKnownLabelMatch: boolean; labelMatches: LabelMatchReference[] } {
  const labelMatches: LabelMatchReference[] = [];
  const seenAddresses = new Set<string>();

  const candidates: Array<{ address: string; relationship: string }> = [
    { address: walletAddress, relationship: "self" },
    ...relationships.map((relationship) => ({
      address: relationship.address,
      relationship: relationship.relationship,
    })),
  ];

  for (const candidate of candidates) {
    if (seenAddresses.has(candidate.address)) {
      continue;
    }
    seenAddresses.add(candidate.address);

    const label = lookupWalletLabel(chain, candidate.address);

    if (!label || label.category === "unknown") {
      continue;
    }

    labelMatches.push({
      address: candidate.address,
      label: label.label,
      relationship: candidate.relationship,
    });
  }

  return {
    hasKnownLabelMatch: labelMatches.length > 0,
    labelMatches,
  };
}
