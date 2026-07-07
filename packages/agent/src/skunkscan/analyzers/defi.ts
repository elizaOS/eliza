import { lookupSolanaProtocol } from "../protocols/registry";
import {
  WalletDeFiProtocol,
  WalletDeFiSummary,
} from "../types";

export function analyzeWalletDeFi(
  parsedTransactions: any[],
): WalletDeFiSummary {
  const protocolMap = new Map<string, WalletDeFiProtocol>();

  for (const transaction of parsedTransactions) {
    const instructions =
      transaction?.transaction?.message?.instructions ?? [];

    for (const instruction of instructions) {
      const programId =
        instruction?.programId ??
        instruction?.programIdIndex ??
        null;

      if (typeof programId !== "string") {
        continue;
      }

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
