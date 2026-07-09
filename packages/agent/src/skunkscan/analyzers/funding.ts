import { ParsedWalletTransaction } from "../parsers/transaction";
import { SupportedChain, WalletFundingSummary } from "../types";
import { lookupWalletLabel } from "../labels/labelEngine";

export function analyzeWalletFunding(
  chain: SupportedChain,
  walletAddress: string,
  firstTransaction: ParsedWalletTransaction | null,
): WalletFundingSummary {
  if (!firstTransaction) {
    return {
      firstFundingTransaction: null,
      firstFundingAt: null,
      fundingWallet: null,
      fundingAmountSol: null,
      fundingSourceType: "unknown",
      fundingSourceLabel: null,
      evidenceConfidence: "low",
      confidence: "low",
      notes: ["No first transaction details were available."],
    };
  }

  const incomingFundingTransfer = firstTransaction.nativeTransfers.find(
    (transfer) =>
      transfer.to === walletAddress &&
      transfer.from !== walletAddress &&
      transfer.amountSol !== null &&
      transfer.amountSol > 0,
  );

  if (!incomingFundingTransfer) {
    return {
      firstFundingTransaction: firstTransaction.signature,
      firstFundingAt: firstTransaction.timestamp,
      fundingWallet: null,
      fundingAmountSol: null,
      fundingSourceType: "unknown",
      fundingSourceLabel: null,
      evidenceConfidence: "medium",
      confidence: "low",
      notes: [
        "No incoming SOL funding transfer was detected in the first known transaction.",
      ],
    };
  }

  const fundingSourceLabel = lookupWalletLabel(
    chain,
    incomingFundingTransfer.from,
  );

  const fundingSourceType =
    fundingSourceLabel?.category === "centralized_exchange"
      ? "exchange"
      : fundingSourceLabel?.category === "bridge"
        ? "bridge"
        : fundingSourceLabel?.category === "system_program" ||
            fundingSourceLabel?.category === "token_program"
          ? "program"
          : "wallet";

  const confidence =
    fundingSourceLabel?.confidence === "high"
      ? "high"
      : fundingSourceLabel?.confidence === "medium"
        ? "medium"
        : "medium";

  return {
    firstFundingTransaction: firstTransaction.signature,
    firstFundingAt: firstTransaction.timestamp,
    fundingWallet: incomingFundingTransfer.from,
    fundingAmountSol: incomingFundingTransfer.amountSol,
    fundingSourceType,
    fundingSourceLabel,
    evidenceConfidence: "high",
    confidence,
    notes: [
      "Initial funding source was inferred from the first known incoming SOL transfer.",
    ],
  };
}
