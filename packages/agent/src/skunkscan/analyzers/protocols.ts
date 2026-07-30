import { ParsedWalletTransaction } from "../parsers/transaction";
import { ChainProtocol, lookupProtocol } from "../protocols/registry";
import { SupportedChain } from "../types";

export interface WalletProtocol {
  programId: string;

  protocol: ChainProtocol;

  interactionCount: number;

  firstInteractionAt: string | null;

  lastInteractionAt: string | null;
}

export interface ProtocolAnalysis {
  totalProtocols: number;

  verifiedProtocols: number;

  protocols: WalletProtocol[];
}

export function analyzeWalletProtocols(
  parsedTransactions: ParsedWalletTransaction[],
  chain: SupportedChain,
): ProtocolAnalysis {
  const discovered = new Map<string, WalletProtocol>();

  for (const transaction of parsedTransactions) {
    const timestamp = transaction.timestamp ?? null;

    for (const programOrContractId of transaction.programOrContractIds) {
      const protocol = lookupProtocol(chain, programOrContractId);

      if (!protocol) {
        continue;
      }

      const existing = discovered.get(programOrContractId);

      if (existing) {
        existing.interactionCount++;

        if (
          timestamp &&
          (!existing.lastInteractionAt ||
            timestamp > existing.lastInteractionAt)
        ) {
          existing.lastInteractionAt = timestamp;
        }

        if (
          timestamp &&
          (!existing.firstInteractionAt ||
            timestamp < existing.firstInteractionAt)
        ) {
          existing.firstInteractionAt = timestamp;
        }

        continue;
      }

      discovered.set(programOrContractId, {
        programId: programOrContractId,
        protocol,
        interactionCount: 1,
        firstInteractionAt: timestamp,
        lastInteractionAt: timestamp,
      });
    }
  }

  const protocols = [...discovered.values()].sort(
    (a, b) => b.interactionCount - a.interactionCount,
  );

  return {
    totalProtocols: protocols.length,
    verifiedProtocols: protocols.filter(
      (protocol) => protocol.protocol.verified,
    ).length,
    protocols,
  };
}
