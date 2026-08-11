import {
  WalletInvestigationResult,
  WalletTrustCheckCard,
  WalletTrustCheckTier,
} from "../types";

// Maps the existing 4-value executiveVerdict.verdict onto the 3-tier
// green/yellow/red Trust Check card. "review" and "investigate" collapse
// into yellow - both mean "not clean, not confirmed dangerous," which is
// the distinction the free card needs to communicate, not the finer-grained
// recommendation the paid report gives.
function tierForVerdict(
  verdict: WalletInvestigationResult["executiveVerdict"],
): WalletTrustCheckTier | null {
  if (!verdict) return null;

  switch (verdict.verdict) {
    case "low_risk":
      return "green";
    case "review":
    case "investigate":
      return "yellow";
    case "high_risk":
      return "red";
    default:
      return null;
  }
}

// Pure response-shaping over an already-computed WalletInvestigationResult -
// no new pipeline stage, no new external calls. investigateWallet() already
// computes executiveVerdict for every successful investigation; this just
// decides how much of it a non-paying caller gets to see.
export function buildTrustCheckCard(
  result: WalletInvestigationResult,
): WalletTrustCheckCard {
  const verdict = result.executiveVerdict;
  const tier = tierForVerdict(verdict);

  return {
    chain: result.chain,
    address: result.address,
    status: result.status,
    tier,
    headline: verdict?.headline ?? result.summary,
    reasons: tier === "red" ? (verdict?.why ?? []) : [],
    riskDisplay: verdict?.riskDisplay,
    trustDisplay: verdict?.trustDisplay,
    exposureDisplay: verdict?.exposureDisplay,
    warnings: result.warnings,
  };
}
