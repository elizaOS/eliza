import { WalletLabel, SupportedChain } from "../types";
import {
  lookupStaticSolanaWalletLabel,
  lookupStaticEthereumWalletLabel,
  lookupStaticBnbWalletLabel,
  lookupStaticBaseWalletLabel,
  lookupStaticBitcoinWalletLabel,
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

    case "bnb": {
      return lookupStaticBnbWalletLabel(address) ?? getUnknownWalletLabel(address);
    }

    case "base": {
      return lookupStaticBaseWalletLabel(address) ?? getUnknownWalletLabel(address);
    }

    // Deliberately small - see STATIC_BITCOIN_LABELS's doc comment in
    // staticRegistry.ts. Covers known exchange reserve/cold wallets only,
    // not per-user deposit addresses (which Bitcoin exchanges typically
    // rotate per-user via HD derivation and never publish).
    case "bitcoin": {
      return lookupStaticBitcoinWalletLabel(address) ?? getUnknownWalletLabel(address);
    }

    default:
      return getUnknownWalletLabel(address);
  }
}
