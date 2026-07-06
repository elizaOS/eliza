import { WalletLabel } from "../types";

const STATIC_SOLANA_LABELS: Record<string, WalletLabel> = {
  "11111111111111111111111111111111": {
    address: "11111111111111111111111111111111",
    label: "Solana System Program",
    category: "system_program",
    confidence: "high",
    source: "static_registry",
  },
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: {
    address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    label: "Solana Token Program",
    category: "token_program",
    confidence: "high",
    source: "static_registry",
  },
};

export function lookupStaticSolanaWalletLabel(
  address: string | null | undefined,
): WalletLabel | null {
  if (!address) {
    return null;
  }

  return STATIC_SOLANA_LABELS[address] ?? null;
}
