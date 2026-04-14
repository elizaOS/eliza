import type {
  WalletConfigStatus,
  WalletEntry,
  WalletPrimaryMap,
} from "@elizaos/shared/contracts/wallet";

interface InventoryWalletAddressState {
  walletAddresses?: {
    evmAddress?: string | null;
    solanaAddress?: string | null;
  } | null;
  walletConfig?: Pick<
    WalletConfigStatus,
    "evmAddress" | "solanaAddress"
  > | null;
  wallets?: WalletEntry[] | null;
  walletPrimary?: WalletPrimaryMap | null;
}

export function resolveInventoryWalletAddresses({
  walletAddresses,
  walletConfig,
  wallets,
  walletPrimary,
}: InventoryWalletAddressState): {
  evmAddress: string | null;
  solanaAddress: string | null;
} {
  const localEvm =
    walletAddresses?.evmAddress ?? walletConfig?.evmAddress ?? null;
  const localSol =
    walletAddresses?.solanaAddress ?? walletConfig?.solanaAddress ?? null;
  const cloudEvm =
    wallets?.find(
      (wallet) => wallet.chain === "evm" && wallet.source === "cloud",
    )?.address ?? null;
  const cloudSol =
    wallets?.find(
      (wallet) => wallet.chain === "solana" && wallet.source === "cloud",
    )?.address ?? null;

  const primaryEvm =
    walletPrimary?.evm ??
    wallets?.find((wallet) => wallet.chain === "evm" && wallet.primary)
      ?.source ??
    "local";
  const primarySol =
    walletPrimary?.solana ??
    wallets?.find((wallet) => wallet.chain === "solana" && wallet.primary)
      ?.source ??
    "local";

  return {
    evmAddress:
      primaryEvm === "cloud" ? (cloudEvm ?? localEvm) : (localEvm ?? cloudEvm),
    solanaAddress:
      primarySol === "cloud" ? (cloudSol ?? localSol) : (localSol ?? cloudSol),
  };
}
