import type {
  WalletConfigStatus,
  WalletEntry,
} from "@elizaos/core";
import type { StewardStatusResponse } from "./types/steward";

export interface StewardUiState {
  connected: boolean;
  showFeatures: boolean;
  title: string;
  description: string;
}

function hasCloudWallet(wallets: WalletEntry[] | null | undefined): boolean {
  return (wallets ?? []).some((wallet) => wallet.source === "cloud");
}

function hasStewardWallet(wallets: WalletEntry[] | null | undefined): boolean {
  return (wallets ?? []).some((wallet) => wallet.provider === "steward");
}

export function resolveStewardUiState(args: {
  stewardStatus?: StewardStatusResponse | null;
  walletConfig?: WalletConfigStatus | null;
  wallets?: WalletEntry[] | null;
}): StewardUiState {
  const { stewardStatus, walletConfig, wallets } = args;
  const connected = stewardStatus?.connected === true;

  if (connected) {
    return {
      connected: true,
      showFeatures: true,
      title: "Steward connected",
      description: "Steward vault management is active for this runtime.",
    };
  }

  const managedWalletActive =
    walletConfig?.walletSource === "managed" || hasCloudWallet(wallets);
  const stewardWalletExpected = hasStewardWallet(wallets);

  if (stewardWalletExpected || stewardStatus?.configured) {
    return {
      connected: false,
      showFeatures: false,
      title: "Steward vault unavailable",
      description:
        "This runtime expects a Steward-managed wallet, but the local Steward bridge is not active.",
    };
  }

  if (managedWalletActive) {
    return {
      connected: false,
      showFeatures: false,
      title: "Steward vault not in use",
      description:
        "This runtime is using Eliza Cloud wallet management, not a local Steward vault.",
    };
  }

  return {
    connected: false,
    showFeatures: false,
    title: "Steward not connected",
    description:
      "Set STEWARD_API_URL and STEWARD_API_KEY in agent settings to enable vault management.",
  };
}
