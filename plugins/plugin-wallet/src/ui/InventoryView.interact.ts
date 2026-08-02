// View-bundle `interact` capability handler, split out of InventoryView.tsx so
// that file exports only React components and stays Fast-Refresh-compatible
// (Vite would full-reload a component file that also exports a plain function).
// The view bundle re-exports `interact` via ./wallet-view-bundle.ts.
import { client } from "@elizaos/ui/api";
import {
  loadWalletViewState,
  resolveWalletAddresses,
} from "./InventoryView.helpers";

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "wallet-state") {
    const state = await loadWalletViewState();
    const addresses = resolveWalletAddresses({
      walletAddresses: state.walletAddresses,
      walletConfig: state.walletConfig,
    });
    return {
      addresses,
      totalUsd: state.summary.totalUsd,
      tokenCount: state.summary.tokens.length,
      nftCount:
        (state.walletNfts?.evm?.reduce(
          (sum, collection) => sum + collection.nfts.length,
          0,
        ) ?? 0) + (state.walletNfts?.solana?.nfts.length ?? 0),
      chainErrors: state.summary.chainErrors,
      tokens: state.summary.tokens.slice(
        0,
        typeof params?.limit === "number" ? params.limit : 20,
      ),
    };
  }

  if (capability === "wallet-market-overview") {
    return {
      overview: await client.getWalletMarketOverview(),
    };
  }

  if (capability === "wallet-trading-profile") {
    const window =
      params?.window === "24h" ||
      params?.window === "7d" ||
      params?.window === "30d"
        ? params.window
        : "30d";
    return {
      profile: await client.getWalletTradingProfile(window),
    };
  }

  throw new Error(`Unsupported capability "${capability}"`);
}
