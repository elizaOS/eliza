import { lookupSolanaProtocol } from "../protocols/registry";
import {
  WalletDeFiProtocol,
  WalletDeFiSummary,
} from "../types";

import { SolanaParsedTransaction } from "../helius";
import { collectProgramIdsFromTransaction } from "../parsers/instructions";

export function analyzeWalletDeFi(
  parsedTransactions: SolanaParsedTransaction[],
): WalletDeFiSummary {
  const protocolMap = new Map<string, WalletDeFiProtocol>();

  for (const transaction of parsedTransactions) {
    const programIds =
      collectProgramIdsFromTransaction(transaction);

    for (const programId of programIds) {
      const protocol = lookupSolanaProtocol(programId);

      if (!protocol) {
        continue;
      }

      const existing = protocolMap.get(protocol.programId);

      if (existing) {
        existing.interactionCount++;
      } else {
        protocolMap.set(protocol.programId, {
          programId: protocol.programId,
          protocol: protocol.name,
          category: protocol.category,
          reputation: protocol.reputation,
          interactionCount: 1,
        });
      }
    }
  }

  const protocols = Array.from(protocolMap.values()).sort(
    (a, b) => b.interactionCount - a.interactionCount,
  );

  const profile =
    protocols.length === 0
      ? "none"
      : protocols.length <= 2
        ? "casual_user"
        : protocols.length <= 5
          ? "active_defi_user"
          : "power_user";

  const notes =
    protocols.length === 0
      ? [
          "No known DeFi protocol interactions were identified in the analyzed transactions.",
        ]
      : [
          "Protocol detection is based on recognized Solana program IDs.",
        ];

  return {
    protocolCount: protocols.length,
    protocols,
    profile,
    notes,
  };
}
