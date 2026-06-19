// Shared data helper for the Vincent view, used by both VincentTuiView
// (in VincentAppView.tsx) and the `interact` capability handler
// (in VincentAppView.interact.ts). Kept out of the .tsx so that file exports
// only React components and stays Fast-Refresh-compatible in dev.
import type { WalletAddresses, WalletBalancesResponse } from "@elizaos/shared";
import { vincentClient } from "./client";
import type {
  VincentStatusResponse,
  VincentStrategyResponse,
  VincentTradingProfileResponse,
} from "./vincent-contracts";

export async function loadVincentTuiState(): Promise<{
  status: VincentStatusResponse;
  walletAddresses: WalletAddresses | null;
  walletBalances: WalletBalancesResponse | null;
  strategy: VincentStrategyResponse;
  tradingProfile: VincentTradingProfileResponse;
}> {
  const status = await vincentClient.vincentStatus();
  const [walletAddresses, walletBalances, strategy, tradingProfile] =
    await Promise.allSettled([
      vincentClient.getWalletAddresses(),
      vincentClient.getWalletBalances(),
      vincentClient.vincentStrategy(),
      vincentClient.vincentTradingProfile(),
    ]);

  return {
    status,
    walletAddresses:
      walletAddresses.status === "fulfilled" ? walletAddresses.value : null,
    walletBalances:
      walletBalances.status === "fulfilled" ? walletBalances.value : null,
    strategy:
      strategy.status === "fulfilled"
        ? strategy.value
        : { connected: status.connected, strategy: null },
    tradingProfile:
      tradingProfile.status === "fulfilled"
        ? tradingProfile.value
        : { connected: status.connected, profile: null },
  };
}
