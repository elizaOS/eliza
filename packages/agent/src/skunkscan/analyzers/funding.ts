import { ParsedWalletTransaction } from "../parsers/transaction";
import { WalletFundingSummary } from "../types";

export function analyzeWalletFunding(
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
      confidence: "low",
      notes: [
        "No incoming SOL funding transfer was detected in the first known transaction.",
      ],
    };
  }

  return {
    firstFundingTransaction: firstTransaction.signature,
    firstFundingAt: firstTransaction.timestamp,
    fundingWallet: incomingFundingTransfer.from,
    fundingAmountSol: incomingFundingTransfer.amountSol,
    fundingSourceType: "wallet",
    confidence: "medium",
    notes: [
      "Initial funding source was inferred from the first known incoming SOL transfer.",
    ],
  };
}
