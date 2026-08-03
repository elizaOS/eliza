import { WalletLabel, SupportedChain } from "../types";
import {
  lookupStaticSolanaWalletLabel,
  lookupStaticEthereumWalletLabel,
} from "./staticRegistry";

export function getUnknownWalletLabel(
  address: string,
): WalletLabel {
  return {
    address,
    label: "Unknown Wallet",
    category: "unknown",
    confidence: "low",
    source: "unknown",
  };
}

export function lookupWalletLabel(
  chain: SupportedChain,
  address: string | null | undefined,
): WalletLabel | null {
  if (!address) {
    return null;
  }

  switch (chain) {
    case "solana": {
      return lookupStaticSolanaWalletLabel(address) ?? getUnknownWalletLabel(address);
    }

    case "ethereum": {
      return lookupStaticEthereumWalletLabel(address) ?? getUnknownWalletLabel(address);
    }

    case "base":
    case "bnb":
      return getUnknownWalletLabel(address);

    default:
      return getUnknownWalletLabel(address);
  }
}
