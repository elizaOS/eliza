import { ParsedWalletTransaction } from "../parsers/transaction";
import { SupportedChain, WalletFundingSummary } from "../types";
import { lookupWalletLabel } from "../labels/labelEngine";
import {
  buildConfidenceAnalysis,
} from "../confidence/framework";

export function analyzeWalletFunding(
  chain: SupportedChain,
  walletAddress: string,
  firstTransaction: ParsedWalletTransaction | null,
  nativeSymbol: string,
): WalletFundingSummary {
  if (!firstTransaction) {
    const confidenceAnalysis = buildConfidenceAnalysis([]);

    return {
      firstFundingTransaction: null,
      firstFundingAt: null,
      fundingWallet: null,
      fundingAmountNative: null,
      fundingTokenId: null,
      fundingAmountToken: null,
      fundingTransferType: "unknown",
      fundingSourceType: "unknown",
      fundingSourceLabel: null,
      evidenceConfidence: confidenceAnalysis.level,
      confidenceAnalysis: {
        rawScore: confidenceAnalysis.score,
        maxScore: 100,
        displayScore: `${(confidenceAnalysis.score / 10).toFixed(1)} / 10`,
        maxDisplayScore: 10,
        level: confidenceAnalysis.level,
        reasons: confidenceAnalysis.reasons,
      },
      confidence: "low",
      notes: ["No first transaction details were available."],
    };
  }

  const incomingNativeFundingTransfer = firstTransaction.nativeTransfers.find(
    (transfer) =>
      transfer.to === walletAddress &&
      transfer.from !== walletAddress &&
      transfer.amountNative !== null &&
      transfer.amountNative > 0,
  );

  if (incomingNativeFundingTransfer) {
    const fundingSourceLabel = lookupWalletLabel(
      chain,
      incomingNativeFundingTransfer.from,
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

    const confidenceAnalysis = buildConfidenceAnalysis([
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
        condition: Boolean(incomingNativeFundingTransfer.from),
        score: 25,
        reason: "Funding wallet was identified.",
      },
      {
        condition: incomingNativeFundingTransfer.amountNative !== null,
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
      fundingWallet: incomingNativeFundingTransfer.from,
      fundingAmountNative: incomingNativeFundingTransfer.amountNative,
      fundingTokenId: null,
      fundingAmountToken: null,
      fundingTransferType: "native",
      fundingSourceType,
      fundingSourceLabel,
      evidenceConfidence: confidenceAnalysis.level,
      confidenceAnalysis: {
        rawScore: confidenceAnalysis.score,
        maxScore: 100,
        displayScore: `${(confidenceAnalysis.score / 10).toFixed(1)} / 10`,
        maxDisplayScore: 10,
        level: confidenceAnalysis.level,
        reasons: confidenceAnalysis.reasons,
      },
      confidence,
      notes: [
        `Initial funding source was inferred from the first known incoming ${nativeSymbol} transfer.`,
      ],
    };
  }

  const incomingTokenFundingTransfer = firstTransaction.tokenTransfers.find(
    (transfer) =>
      transfer.to === walletAddress &&
      transfer.from !== walletAddress &&
      transfer.amount !== null &&
      transfer.amount > 0,
  );

  if (incomingTokenFundingTransfer) {
    const fundingSourceLabel = lookupWalletLabel(
      chain,
      incomingTokenFundingTransfer.from,
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

    const confidenceAnalysis = buildConfidenceAnalysis([
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
        condition: Boolean(incomingTokenFundingTransfer.from),
        score: 25,
        reason: "Funding wallet was identified via a token transfer.",
      },
      {
        condition: incomingTokenFundingTransfer.amount !== null,
        score: 15,
        reason: "Funding amount was identified via a token transfer.",
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
      fundingWallet: incomingTokenFundingTransfer.from,
      fundingAmountNative: null,
      fundingTokenId: incomingTokenFundingTransfer.contractAddress,
      fundingAmountToken: incomingTokenFundingTransfer.amount,
      fundingTransferType: "token",
      fundingSourceType,
      fundingSourceLabel,
      evidenceConfidence: confidenceAnalysis.level,
      confidenceAnalysis: {
        rawScore: confidenceAnalysis.score,
        maxScore: 100,
        displayScore: `${(confidenceAnalysis.score / 10).toFixed(1)} / 10`,
        maxDisplayScore: 10,
        level: confidenceAnalysis.level,
        reasons: confidenceAnalysis.reasons,
      },
      confidence,
      notes: [
        `No incoming native ${nativeSymbol} transfer was found in the first known transaction.`,
        "Initial funding source was instead inferred from the first known incoming token transfer.",
      ],
    };
  }

  const confidenceAnalysis = buildConfidenceAnalysis([
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
      condition:
        firstTransaction.nativeTransfers.length > 0 ||
        firstTransaction.tokenTransfers.length > 0,
      score: 20,
      reason: "Transfer data was available.",
    },
  ]);

  return {
    firstFundingTransaction: firstTransaction.signature,
    firstFundingAt: firstTransaction.timestamp,
    fundingWallet: null,
    fundingAmountNative: null,
    fundingTokenId: null,
    fundingAmountToken: null,
    fundingTransferType: "unknown",
    fundingSourceType: "unknown",
    fundingSourceLabel: null,
    evidenceConfidence: confidenceAnalysis.level,
    confidenceAnalysis: {
      rawScore: confidenceAnalysis.score,
      maxScore: 100,
      displayScore: `${(confidenceAnalysis.score / 10).toFixed(1)} / 10`,
      maxDisplayScore: 10,
      level: confidenceAnalysis.level,
      reasons: confidenceAnalysis.reasons,
    },
    confidence: "low",
    notes: [
      `No incoming ${nativeSymbol} or token funding transfer was detected in the first known transaction.`,
    ],
  };
}
