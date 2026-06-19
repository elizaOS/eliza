// Shared wallet data helpers for the inventory view, used by both InventoryView /
// InventoryTuiView (in InventoryView.tsx) and the `interact` capability handler
// (in InventoryView.interact.ts). Kept out of the .tsx so that file exports only
// React components and stays Fast-Refresh-compatible in dev.
import type {
  WalletAddresses,
  WalletBalancesResponse,
  WalletConfigStatus,
} from "@elizaos/shared";
import { client } from "@elizaos/ui/api";

export function resolveWalletAddresses({
  walletAddresses,
  walletConfig,
}: {
  walletAddresses: WalletAddresses | null;
  walletConfig: WalletConfigStatus | null;
}): {
  evmAddress: string | null;
  solanaAddress: string | null;
} {
  return {
    evmAddress: walletAddresses?.evmAddress ?? walletConfig?.evmAddress ?? null,
    solanaAddress:
      walletAddresses?.solanaAddress ?? walletConfig?.solanaAddress ?? null,
  };
}

function parseUsd(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function summarizeWalletBalances(
  walletBalances: WalletBalancesResponse | null,
): {
  totalUsd: number;
  tokens: Array<{
    chain: string;
    symbol: string;
    name: string;
    contractAddress: string | null;
    balance: string;
    valueUsd: number;
    isNative: boolean;
  }>;
  chainErrors: Array<{ chain: string; error: string }>;
} {
  const tokens: Array<{
    chain: string;
    symbol: string;
    name: string;
    contractAddress: string | null;
    balance: string;
    valueUsd: number;
    isNative: boolean;
  }> = [];
  const chainErrors: Array<{ chain: string; error: string }> = [];

  for (const chain of walletBalances?.evm?.chains ?? []) {
    const nativeValueUsd = parseUsd(chain.nativeValueUsd);
    tokens.push({
      chain: chain.chain,
      symbol: chain.nativeSymbol,
      name: `${chain.chain} native`,
      contractAddress: null,
      balance: chain.nativeBalance,
      valueUsd: nativeValueUsd,
      isNative: true,
    });
    if (chain.error) {
      chainErrors.push({ chain: chain.chain, error: chain.error });
      continue;
    }
    for (const token of chain.tokens) {
      tokens.push({
        chain: chain.chain,
        symbol: token.symbol,
        name: token.name,
        contractAddress: token.contractAddress,
        balance: token.balance,
        valueUsd: parseUsd(token.valueUsd),
        isNative: false,
      });
    }
  }

  if (walletBalances?.solana) {
    tokens.push({
      chain: "Solana",
      symbol: "SOL",
      name: "Solana native",
      contractAddress: null,
      balance: walletBalances.solana.solBalance,
      valueUsd: parseUsd(walletBalances.solana.solValueUsd),
      isNative: true,
    });
    for (const token of walletBalances.solana.tokens) {
      tokens.push({
        chain: "Solana",
        symbol: token.symbol,
        name: token.name,
        contractAddress: token.mint,
        balance: token.balance,
        valueUsd: parseUsd(token.valueUsd),
        isNative: false,
      });
    }
  }

  tokens.sort((a, b) => b.valueUsd - a.valueUsd);
  return {
    totalUsd: tokens.reduce((sum, token) => sum + token.valueUsd, 0),
    tokens,
    chainErrors,
  };
}

export async function loadWalletTuiState() {
  const [
    walletAddresses,
    walletConfig,
    walletBalances,
    walletNfts,
    marketOverview,
  ] = await Promise.all([
    client.getWalletAddresses().catch(() => null),
    client.getWalletConfig().catch(() => null),
    client.getWalletBalances().catch(() => null),
    client.getWalletNfts().catch(() => null),
    client.getWalletMarketOverview().catch(() => null),
  ]);
  const summary = summarizeWalletBalances(walletBalances);
  return {
    walletAddresses,
    walletConfig,
    walletBalances,
    walletNfts,
    marketOverview,
    summary,
  };
}
