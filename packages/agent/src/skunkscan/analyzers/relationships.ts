import {
  SupportedChain,
  WalletFundingSummary,
  WalletLabel,
  WalletLabelCategory,
  WalletRelationship,
  WalletRelationshipSummary,
} from "../types";
import { ParsedWalletTransaction } from "../parsers/transaction";
import { lookupWalletLabel } from "../labels/labelEngine";
import { lookupProtocol } from "../protocols/registry";
import {
  createConfidenceResponse,
} from "../confidence/framework";

// Label categories treated as "known infrastructure" - shared by enough
// unrelated wallets that a connection to one isn't clustering evidence.
// Deliberately excludes "suspicious"/"scam"/"rug_pull" (the opposite case -
// a shared connection to a known-bad address IS worth surfacing) and
// "unknown"/"personal_wallet" (not infrastructure at all). burn_address is
// included even though it's not literally infrastructure, for the same
// "millions of wallets touch this same address" reason.
const INFRASTRUCTURE_LABEL_CATEGORIES: ReadonlySet<WalletLabelCategory> =
  new Set([
    "centralized_exchange",
    "decentralized_exchange",
    "bridge",
    "defi_protocol",
    "nft_marketplace",
    "staking",
    "token_program",
    "system_program",
    "burn_address",
  ]);

// Checks the protocol registry (primary - any match means a recognized
// program/contract, not a private wallet) and the label registry (for the
// centralized-exchange case protocols/registry.ts doesn't cover). Returns
// a display name when infrastructure is detected, or null when the address
// is a genuinely unknown counterparty (real relationship/clustering
// evidence) or matches a suspicious/scam/rug_pull label (also real
// evidence, deliberately not excluded).
function detectKnownInfrastructure(
  chain: SupportedChain,
  address: string,
): string | null {
  const protocol = lookupProtocol(chain, address);

  if (protocol) {
    return protocol.name;
  }

  const walletLabel: WalletLabel | null = lookupWalletLabel(chain, address);

  if (
    walletLabel &&
    INFRASTRUCTURE_LABEL_CATEGORIES.has(walletLabel.category)
  ) {
    return walletLabel.label;
  }

  return null;
}

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
  investigatedAddresses: ReadonlySet<string>,
): boolean {
  return address !== undefined && investigatedAddresses.has(address);
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
  // A Set, not an array - isInvestigatedAddress is called up to 4x per
  // transfer, across every parsed transaction, so an array .includes() scan
  // here is O(transactions x transfers x addresses) for a Bitcoin xpub with
  // many derived addresses (found via the cross-chain unbounded-fetch
  // audit, alongside the same array-vs-Set gap in funding.ts).
  const normalizedInvestigatedAddresses = new Set(
    (typeof investigatedAddress === "string"
      ? [investigatedAddress]
      : investigatedAddress
    ).map((address) => address.trim()),
  );

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

        const infrastructureLabel = detectKnownInfrastructure(
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

        if (infrastructureLabel) {
          evidenceReasons.push(
            `Recognized as known infrastructure (${infrastructureLabel}) - shared by many unrelated wallets, so this connection is not treated as clustering evidence.`,
          );
        }

        return {
          address: counterparty.address,
          relationship: relationshipType,
          label: walletLabel?.label ?? null,
          confidence,
          direction,
          interactionCount,
          isKnownInfrastructure: infrastructureLabel !== null,
          infrastructureLabel,
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
      const fundingInfrastructureLabel = detectKnownInfrastructure(
        chain,
        funding.fundingWallet,
      );

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
        isKnownInfrastructure: fundingInfrastructureLabel !== null,
        infrastructureLabel: fundingInfrastructureLabel,
        evidenceReasons: [
          "The address was identified as the wallet's funding source.",
          ...(fundingInfrastructureLabel
            ? [
                `Recognized as known infrastructure (${fundingInfrastructureLabel}) - being funded by widely-shared infrastructure is not treated as clustering evidence.`,
              ]
            : []),
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

  // Known infrastructure (DEX routers, exchange hot wallets, bridges, etc.)
  // stays in `relationships` above for display/context, but is excluded
  // here - shared by millions of unrelated wallets, so it isn't clustering
  // evidence the way a shared unknown private wallet is. See
  // detectKnownInfrastructure's doc comment.
  const nonInfrastructureRelationships = relationships.filter(
    (relationship) => !relationship.isKnownInfrastructure,
  );
  const knownInfrastructureCount =
    relationships.length - nonInfrastructureRelationships.length;

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
      condition: nonInfrastructureRelationships.length > 0,
      score: 25,
      reason: "At least one direct relationship was identified.",
    },
    {
      condition: nonInfrastructureRelationships.some(
        (relationship) =>
          relationship.direction === "bidirectional",
      ),
      score: 10,
      reason: "At least one bidirectional relationship was identified.",
    },
  ]);

  const confidence =
    nonInfrastructureRelationships.length === 0
      ? "low"
      : confidenceAnalysis.level;

  const notes: string[] =
    nonInfrastructureRelationships.length === 0
      ? [
          "No direct wallet relationships were identified from the available transaction sample.",
        ]
      : [
          "Relationships were derived from funding, native-transfer, and token-transfer evidence.",
          "Results represent the parsed transaction sample and may not include the wallet's complete history.",
        ];

  if (knownInfrastructureCount > 0) {
    notes.push(
      `${knownInfrastructureCount} of the connections shown are known infrastructure (exchanges, DEX routers, bridges, etc.) - shown for context, but not counted as clustering evidence since they're shared by many unrelated wallets.`,
    );
  }

  return {
    relationshipCount: nonInfrastructureRelationships.length,
    knownInfrastructureCount,
    evidenceConfidence: confidenceAnalysis.level,
    confidenceAnalysis,
    relationships,
    confidence,
    notes,
  };
}
