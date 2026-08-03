import { lookupProtocol } from "../protocols/registry";
import {
  SupportedChain,
  WalletDeFiProtocol,
  WalletDeFiSummary,
} from "../types";

import { ParsedWalletTransaction } from "../parsers/transaction";

export function analyzeWalletDeFi(
  parsedTransactions: ParsedWalletTransaction[],
  chain: SupportedChain,
): WalletDeFiSummary {
  const protocolMap = new Map<string, WalletDeFiProtocol>();

  for (const transaction of parsedTransactions) {
    for (const programOrContractId of transaction.programOrContractIds) {
      const protocol = lookupProtocol(chain, programOrContractId);

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
          "This reflects only the wallet's most recently analyzed transactions, so results can differ between investigation runs for very active wallets.",
        ]
      : [
          "Protocol detection is based on recognized program or contract IDs.",
          "This reflects only the wallet's most recently analyzed transactions, so results can differ between investigation runs for very active wallets.",
        ];

  return {
    protocolCount: protocols.length,
    protocols,
    profile,
    notes,
  };
}
