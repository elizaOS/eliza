import { WalletAgeSummary } from "../types";

export function analyzeWalletAge(
  firstKnownTransactionSignature: string | null,
  firstKnownTransactionTime: number | null,
): WalletAgeSummary {
  if (
    !firstKnownTransactionSignature ||
    firstKnownTransactionTime === null
  ) {
    return {
      firstKnownTransaction: null,
      firstKnownTransactionAt: null,
      ageInDays: null,
      ageInMonths: null,
      classification: "unknown",
    };
  }

  const now = Math.floor(Date.now() / 1000);

  const ageInDays = Math.floor(
    (now - firstKnownTransactionTime) / 86400,
  );

  const ageInMonths = Math.floor(ageInDays / 30);

  let classification: WalletAgeSummary["classification"] = "new";

  if (ageInMonths >= 24) {
    classification = "veteran";
  } else if (ageInMonths >= 6) {
    classification = "established";
  }

  return {
    firstKnownTransaction: firstKnownTransactionSignature,
    firstKnownTransactionAt: firstKnownTransactionTime,
    ageInDays,
    ageInMonths,
    classification,
  };
}
