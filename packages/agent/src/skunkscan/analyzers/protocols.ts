import { SolanaParsedTransaction } from "../helius";
import { SolanaProtocol, lookupSolanaProtocol } from "../protocols/registry";

export interface WalletProtocol {
  programId: string;

  protocol: SolanaProtocol;

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
  parsedTransactions: SolanaParsedTransaction[],
): ProtocolAnalysis {
  const discovered = new Map<string, WalletProtocol>();

  for (const transaction of parsedTransactions) {
    const timestamp = transaction.timestamp ?? null;

    for (const instruction of transaction.instructions ?? []) {
      const programId = instruction.programId;

      if (!programId) {
        continue;
      }

      const protocol = lookupSolanaProtocol(programId);

      if (!protocol) {
        continue;
      }

      const existing = discovered.get(programId);

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

      discovered.set(programId, {
        programId,
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
