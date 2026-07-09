import { ParsedWalletTransaction } from "../parsers/transaction";
import { SupportedChain, WalletFundingSummary } from "../types";
import { lookupWalletLabel } from "../labels/labelEngine";
import {
  buildConfidenceInput,
  confidenceLevelFromScore,
} from "../confidence/framework";

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
    const evidenceConfidenceInput = buildConfidenceInput([
      {
        condition: Boolean(firstTransaction.signature),
        score: 30,
        reason: "First known transaction signature was available.",
      },
      {
        condition: typeof firstTransaction.timestamp === "number",
        score: 20,
        reason: "First known transaction timestamp was available.",
      },
      {
        condition: firstTransaction.nativeTransfers.length > 0,
        score: 20,
        reason: "Native transfer data was available.",
      },
    ]);

    return {
      firstFundingTransaction: firstTransaction.signature,
      firstFundingAt: firstTransaction.timestamp,
      fundingWallet: null,
      fundingAmountSol: null,
      fundingSourceType: "unknown",
      fundingSourceLabel: null,
      evidenceConfidence: confidenceLevelFromScore(
        evidenceConfidenceInput.score,
      ),
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

  const evidenceConfidenceInput = buildConfidenceInput([
    {
      condition: Boolean(firstTransaction.signature),
      score: 20,
      reason: "First known transaction signature was available.",
    },
    {
      condition: typeof firstTransaction.timestamp === "number",
      score: 15,
      reason: "First known transaction timestamp was available.",
    },
    {
      condition: Boolean(incomingFundingTransfer.from),
      score: 25,
      reason: "Funding wallet was identified.",
    },
    {
      condition: incomingFundingTransfer.amountSol !== null,
      score: 20,
      reason: "Funding amount was identified.",
    },
    {
      condition: Boolean(fundingSourceLabel),
      score: 20,
      reason: "Funding source label was identified.",
    },
  ]);

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
    evidenceConfidence: confidenceLevelFromScore(
      evidenceConfidenceInput.score,
    ),
    confidence,
    notes: [
      "Initial funding source was inferred from the first known incoming SOL transfer.",
    ],
  };
}
