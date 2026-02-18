import type { Verdict } from "../client/types.js";
import { getVerdict, type VerdictInfo } from "./trust-levels.js";

export interface TransactionRecommendation {
  verdict: VerdictInfo;
  safe: boolean;
  message: string;
}

export function getTransactionRecommendation(
  score: number,
  requestedAmount?: number
): TransactionRecommendation {
  const verdict = getVerdict(score);
  const safe =
    requestedAmount === undefined || requestedAmount <= verdict.maxTransaction;

  let message: string;
  if (verdict.verdict === "NOT_RECOMMENDED") {
    message = "This service is not recommended for any transactions.";
  } else if (requestedAmount !== undefined && !safe) {
    message = `Requested $${requestedAmount} exceeds recommended max of $${verdict.maxTransaction} for ${verdict.label} services.`;
  } else if (requestedAmount !== undefined) {
    message = `$${requestedAmount} is within safe limits (max $${verdict.maxTransaction}) for ${verdict.label} services.`;
  } else {
    message = `${verdict.label}: max transaction $${verdict.maxTransaction}.`;
  }

  return { verdict, safe, message };
}

export function formatServiceSummary(
  domain: string,
  score: number,
  level: string,
  verdict: Verdict,
  maxTransaction: number,
  flags: string[]
): string {
  const warningFlags = flags.filter(
    (f) =>
      ![
        "HAS_COMPLETE_SCHEMA",
        "GOOD_DOCUMENTATION",
        "PROTOCOL_COMPLIANT",
        "CONTRACT_VERIFIED",
        "SCHEMA_VERIFIED",
        "FIDELITY_PROVEN",
        "SELF_DOCUMENTING",
        "X402_V1",
        "X402_V2",
      ].includes(f)
  );

  let summary = `${domain}: Score ${score}/100 (${level}). Verdict: ${verdict} (max $${maxTransaction}).`;

  if (warningFlags.length > 0) {
    summary += ` Flags: ${warningFlags.join(", ")}.`;
  }

  return summary;
}