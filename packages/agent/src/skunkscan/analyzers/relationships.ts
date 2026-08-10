import {
  SupportedChain,
  WalletFundingSummary,
  WalletRelationship,
  WalletRelationshipSummary,
} from "../types";
import { ParsedWalletTransaction } from "../parsers/transaction";
import { lookupWalletLabel } from "../labels/labelEngine";
import {
  createConfidenceResponse,
} from "../confidence/framework";

type RelationshipAccumulator = {
  address: string;
  incomingTransferCount: number;
  outgoingTransferCount: number;
  interactionSignatures: Set<string>;
  timestamps: number[];
  totalNativeAmountReceived: number;
  totalNativeAmountSent: number;
  hasNativeTransfer: boolean;
  hasTokenTransfer: boolean;
};

function getOrCreateRelationship(
  relationships: Map<string, RelationshipAccumulator>,
  address: string,
): RelationshipAccumulator {
  const existing = relationships.get(address);

  if (existing) {
    return existing;
  }

  const created: RelationshipAccumulator = {
    address,
    incomingTransferCount: 0,
    outgoingTransferCount: 0,
    interactionSignatures: new Set<string>(),
    timestamps: [],
    totalNativeAmountReceived: 0,
    totalNativeAmountSent: 0,
    hasNativeTransfer: false,
    hasTokenTransfer: false,
  };

  relationships.set(address, created);

  return created;
}

function recordTransactionEvidence(
  relationship: RelationshipAccumulator,
  transaction: ParsedWalletTransaction,
): void {
  if (transaction.signature) {
    relationship.interactionSignatures.add(
      transaction.signature,
    );
  }

  if (typeof transaction.timestamp === "number") {
    relationship.timestamps.push(
      transaction.timestamp,
    );
  }
}

function isInvestigatedAddress(
  address: string | undefined,
  investigatedAddresses: readonly string[],
): boolean {
  return address !== undefined && investigatedAddresses.includes(address);
}

export function analyzeWalletRelationships(
  funding: WalletFundingSummary,
  // Accepts a single address (every existing caller) or a readonly array
  // (Bitcoin xpub wallets - a transfer can involve any of several derived
  // addresses, not just one). Single-string behavior is unchanged. See
  // analyzers/exposure.ts/funding.ts for the same treatment.
  investigatedAddress: string | readonly string[],
  parsedTransactions: ParsedWalletTransaction[],
  chain: SupportedChain,
): WalletRelationshipSummary {
  const normalizedInvestigatedAddresses = (
    typeof investigatedAddress === "string"
      ? [investigatedAddress]
      : investigatedAddress
  ).map((address) => address.trim());

  const counterpartyMap =
    new Map<string, RelationshipAccumulator>();

  for (const transaction of parsedTransactions) {
    for (const transfer of transaction.nativeTransfers) {
      const fromAddress = transfer.from?.trim();

      const toAddress = transfer.to?.trim();

      // Already denominated in the native asset by the parser, which also
      // yields null when the source transfer carried no usable amount.
      // Fall back to zero so totals stay numeric rather than becoming NaN.
      const amountNative = transfer.amountNative ?? 0;

      if (
        isInvestigatedAddress(fromAddress, normalizedInvestigatedAddresses) &&
        toAddress &&
        !isInvestigatedAddress(toAddress, normalizedInvestigatedAddresses)
      ) {
        const relationship = getOrCreateRelationship(
          counterpartyMap,
          toAddress,
        );

        relationship.outgoingTransferCount += 1;
        relationship.totalNativeAmountSent += amountNative;
        relationship.hasNativeTransfer = true;

        recordTransactionEvidence(
          relationship,
          transaction,
        );
      }

      if (
        isInvestigatedAddress(toAddress, normalizedInvestigatedAddresses) &&
        fromAddress &&
        !isInvestigatedAddress(fromAddress, normalizedInvestigatedAddresses)
      ) {
        const relationship = getOrCreateRelationship(
          counterpartyMap,
          fromAddress,
        );

        relationship.incomingTransferCount += 1;
        relationship.totalNativeAmountReceived += amountNative;
        relationship.hasNativeTransfer = true;

        recordTransactionEvidence(
          relationship,
          transaction,
        );
      }
    }

    for (const transfer of transaction.tokenTransfers) {
      const fromAddress = transfer.from?.trim();

      const toAddress = transfer.to?.trim();

      if (
        isInvestigatedAddress(fromAddress, normalizedInvestigatedAddresses) &&
        toAddress &&
        !isInvestigatedAddress(toAddress, normalizedInvestigatedAddresses)
      ) {
        const relationship = getOrCreateRelationship(
          counterpartyMap,
          toAddress,
        );

        relationship.outgoingTransferCount += 1;
        relationship.hasTokenTransfer = true;

        recordTransactionEvidence(
          relationship,
          transaction,
        );
      }

      if (
        isInvestigatedAddress(toAddress, normalizedInvestigatedAddresses) &&
        fromAddress &&
        !isInvestigatedAddress(fromAddress, normalizedInvestigatedAddresses)
      ) {
        const relationship = getOrCreateRelationship(
          counterpartyMap,
          fromAddress,
        );

        relationship.incomingTransferCount += 1;
        relationship.hasTokenTransfer = true;

        recordTransactionEvidence(
          relationship,
          transaction,
        );
      }
    }
  }

  const relationships: WalletRelationship[] =
    Array.from(counterpartyMap.values()).map(
      (counterparty) => {
        const hasIncoming =
          counterparty.incomingTransferCount > 0;

        const hasOutgoing =
          counterparty.outgoingTransferCount > 0;

        const direction =
          hasIncoming && hasOutgoing
            ? "bidirectional"
            : hasIncoming
              ? "incoming"
              : hasOutgoing
                ? "outgoing"
                : "unknown";

        const relationshipType =
          direction === "incoming"
            ? "sender"
            : direction === "outgoing"
              ? "receiver"
              : "counterparty";

        const interactionCount =
          counterparty.interactionSignatures.size > 0
            ? counterparty.interactionSignatures.size
            : counterparty.incomingTransferCount +
              counterparty.outgoingTransferCount;

        const walletLabel = lookupWalletLabel(
          chain,
          counterparty.address,
        );

        const confidence =
          direction === "bidirectional" ||
          interactionCount >= 5
            ? "high"
            : interactionCount >= 2
              ? "medium"
              : "low";

        const evidenceReasons: string[] = [];

        if (counterparty.hasNativeTransfer) {
          evidenceReasons.push(
            "Direct native-asset transfers were identified.",
          );
        }

        if (counterparty.hasTokenTransfer) {
          evidenceReasons.push(
            "Direct token transfers were identified.",
          );
        }

        if (direction === "bidirectional") {
          evidenceReasons.push(
            "Transfers were observed in both directions.",
          );
        }

        return {
          address: counterparty.address,
          relationship: relationshipType,
          label: walletLabel?.label ?? null,
          confidence,
          direction,
          interactionCount,
          incomingTransferCount:
            counterparty.incomingTransferCount,
          outgoingTransferCount:
            counterparty.outgoingTransferCount,
          firstInteractionAt:
            counterparty.timestamps.length > 0
              ? Math.min(...counterparty.timestamps)
              : null,
          lastInteractionAt:
            counterparty.timestamps.length > 0
              ? Math.max(...counterparty.timestamps)
              : null,
          totalNativeAmountReceived:
            counterparty.totalNativeAmountReceived,
          totalNativeAmountSent:
            counterparty.totalNativeAmountSent,
          transactionSignatures: Array.from(
            counterparty.interactionSignatures,
          ),
          evidenceReasons,
          limitations: [
            "Relationship analysis is limited to the parsed transaction sample.",
            "A transfer relationship does not prove common ownership or control.",
          ],
        };
      },
    );

  if (funding.fundingWallet) {
    const existingFundingRelationship =
      relationships.find(
        (relationship) =>
          relationship.address ===
          funding.fundingWallet,
      );

    if (existingFundingRelationship) {
      existingFundingRelationship.relationship =
        "funder";

      existingFundingRelationship.label =
        funding.fundingSourceLabel?.label ?? null;

      existingFundingRelationship.confidence =
        funding.confidence;

      existingFundingRelationship.evidenceReasons = [
        ...(existingFundingRelationship.evidenceReasons ??
          []),
        "The address was identified as the wallet's funding source.",
      ];
    } else {
      relationships.push({
        address: funding.fundingWallet,
        relationship: "funder",
        label:
          funding.fundingSourceLabel?.label ?? null,
        confidence: funding.confidence,
        direction: "incoming",
        interactionCount: 1,
        incomingTransferCount: 1,
        outgoingTransferCount: 0,
        firstInteractionAt:
          funding.firstFundingAt ?? null,
        lastInteractionAt:
          funding.firstFundingAt ?? null,
        totalNativeAmountReceived:
          funding.fundingAmountNative ?? 0,
        totalNativeAmountSent: 0,
        transactionSignatures:
          funding.firstFundingTransaction
            ? [funding.firstFundingTransaction]
            : [],
        evidenceReasons: [
          "The address was identified as the wallet's funding source.",
        ],
        limitations: [
          "The funding relationship is based on the earliest parsed funding evidence.",
          "A funding transfer does not prove common ownership or control.",
        ],
      });
    }
  }

  relationships.sort(
    (first, second) =>
      (second.interactionCount ?? 0) -
      (first.interactionCount ?? 0),
  );

  const confidenceAnalysis = createConfidenceResponse([
    {
      condition: funding.evidenceConfidence === "high",
      score: 25,
      reason: "Funding evidence confidence is high.",
    },
    {
      condition: funding.evidenceConfidence === "medium",
      score: 15,
      reason: "Funding evidence confidence is medium.",
    },
    {
      condition: parsedTransactions.length > 0,
      score: 25,
      reason: "Parsed transaction evidence was available.",
    },
    {
      condition: relationships.length > 0,
      score: 25,
      reason: "At least one direct relationship was identified.",
    },
    {
      condition: relationships.some(
        (relationship) =>
          relationship.direction === "bidirectional",
      ),
      score: 10,
      reason: "At least one bidirectional relationship was identified.",
    },
  ]);

  const confidence =
    relationships.length === 0
      ? "low"
      : confidenceAnalysis.level;

  return {
    relationshipCount: relationships.length,
    evidenceConfidence: confidenceAnalysis.level,
    confidenceAnalysis,
    relationships,
    confidence,
    notes:
      relationships.length === 0
        ? [
            "No direct wallet relationships were identified from the available transaction sample.",
          ]
        : [
            "Relationships were derived from funding, native-transfer, and token-transfer evidence.",
            "Results represent the parsed transaction sample and may not include the wallet's complete history.",
          ],
  };
}
