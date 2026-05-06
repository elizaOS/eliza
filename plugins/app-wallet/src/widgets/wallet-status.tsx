import { Check, Copy, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "@elizaos/app-core/state";
import {
  EmptyWidgetState,
  WidgetSection,
} from "@elizaos/app-core/components/chat/widgets/shared";
import type {
  ChatSidebarWidgetDefinition,
  ChatSidebarWidgetProps,
} from "@elizaos/app-core/components/chat/widgets/types";
import {
  type ChainKey,
  getNativeLogoUrl,
  resolveChainKey,
} from "../inventory/chainConfig";
import { normalizeInventoryImageUrl } from "../inventory/media-url";

const DUST_THRESHOLD_USD = 0.01;
const COPY_FEEDBACK_MS = 1200;
const EVM_CHAIN_ORDER: ChainKey[] = [
  "ethereum",
  "base",
  "arbitrum",
  "optimism",
  "polygon",
  "bsc",
  "avax",
];
const EVM_CHAIN_KEYS = new Set<ChainKey>(EVM_CHAIN_ORDER);
const CHAIN_DISPLAY_LABELS: Record<ChainKey, string> = {
  ethereum: "Ethereum",
  base: "Base",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
  polygon: "Polygon",
  bsc: "BNB Chain",
  avax: "Avalanche",
  solana: "Solana",
};

function shortenAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function parseUsd(value: string | null | undefined): number {
  if (typeof value !== "string") return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatUsd(value: number): string {
  if (value >= 1000) {
    return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  }
  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toFixed(2)}`;
}

function hasPositiveBalance(value: string | null | undefined): boolean {
  if (!value) return false;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function normalizeEvmChainKeys(chainNames: readonly string[]): ChainKey[] {
  const seen = new Set<ChainKey>();
  for (const chainName of chainNames) {
    const chainKey = resolveChainKey(chainName);
    if (chainKey && EVM_CHAIN_KEYS.has(chainKey)) {
      seen.add(chainKey);
    }
  }
  return EVM_CHAIN_ORDER.filter((chainKey) => seen.has(chainKey));
}

function ChainBadge({ chain }: { chain: ChainKey }) {
  // Use the same per-chain logo URLs the wallet page uses — these are real
  // raster logos pulled from the trustwallet/assets repo (see
  // CHAIN_CONFIGS[*].nativeLogoUrl) and cover every chain we register,
  // including Arbitrum / Optimism / Polygon that the SVG-only ChainIcon
  // doesn't have paths for.
  const [errored, setErrored] = useState(false);
  const label = CHAIN_DISPLAY_LABELS[chain];
  const url = errored
    ? null
    : (normalizeInventoryImageUrl(getNativeLogoUrl(chain)) ?? null);

  if (url) {
    return (
      <img
        src={url}
        alt={label}
        title={label}
        width={16}
        height={16}
        className="inline-flex h-4 w-4 shrink-0 rounded-full bg-bg/40 object-cover"
        onError={() => setErrored(true)}
      />
    );
  }
  // Tiny initials fallback when the logo URL fails or is missing.
  return (
    <span
      className="inline-flex h-4 shrink-0 items-center rounded-full border border-border/35 bg-bg/40 px-1.5 font-mono text-[0.52rem] font-semibold leading-none text-muted"
      title={label}
      role="img"
      aria-label={label}
    >
      {label.slice(0, 3).toUpperCase()}
    </span>
  );
}

function ChainBadges({ chains }: { chains: readonly ChainKey[] }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {chains.map((chain) => (
        <ChainBadge key={chain} chain={chain} />
      ))}
    </span>
  );
}

interface CopyButtonProps {
  value: string;
  label: string;
}

function CopyAddressButton({ value, label }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function onClick(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard) {
        return;
      }
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      return;
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      title={copied ? "Copied" : "Copy"}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt"
    >
      {copied ? (
        <Check className="h-3 w-3" aria-hidden />
      ) : (
        <Copy className="h-3 w-3" aria-hidden />
      )}
    </button>
  );
}

export function WalletStatusSidebarWidget(_props: ChatSidebarWidgetProps) {
  const {
    walletEnabled,
    walletAddresses,
    walletConfig,
    walletBalances,
    loadWalletConfig,
    loadBalances,
    setTab,
  } = useApp();

  useEffect(() => {
    if (walletEnabled === false) return;
    if (walletConfig === null) {
      void loadWalletConfig();
    }
    if (walletBalances !== null) return;
    void loadBalances();
  }, [
    walletEnabled,
    walletConfig,
    walletBalances,
    loadWalletConfig,
    loadBalances,
  ]);

  const evmAddress = walletAddresses?.evmAddress ?? null;
  const solanaAddress = walletAddresses?.solanaAddress ?? null;
  const evmShort = shortenAddress(evmAddress);
  const solanaShort = shortenAddress(solanaAddress);
  const evmChains = normalizeEvmChainKeys([
    ...(walletConfig?.evmChains ?? []),
    ...(walletBalances?.evm?.chains.map((chain) => chain.chain) ?? []),
  ]);

  const walletSummary = useMemo(() => {
    let assetCount = 0;
    let totalUsd = 0;
    if (walletBalances?.evm) {
      for (const chain of walletBalances.evm.chains) {
        const nativeUsd = parseUsd(chain.nativeValueUsd);
        totalUsd += nativeUsd;
        if (
          nativeUsd >= DUST_THRESHOLD_USD ||
          hasPositiveBalance(chain.nativeBalance)
        ) {
          assetCount += 1;
        }
        for (const token of chain.tokens) {
          const tokenUsd = parseUsd(token.valueUsd);
          totalUsd += tokenUsd;
          if (
            tokenUsd >= DUST_THRESHOLD_USD ||
            hasPositiveBalance(token.balance)
          ) {
            assetCount += 1;
          }
        }
      }
    }
    if (walletBalances?.solana) {
      const nativeUsd = parseUsd(walletBalances.solana.solValueUsd);
      totalUsd += nativeUsd;
      if (
        nativeUsd >= DUST_THRESHOLD_USD ||
        hasPositiveBalance(walletBalances.solana.solBalance)
      ) {
        assetCount += 1;
      }
      for (const token of walletBalances.solana.tokens) {
        const tokenUsd = parseUsd(token.valueUsd);
        totalUsd += tokenUsd;
        if (
          tokenUsd >= DUST_THRESHOLD_USD ||
          hasPositiveBalance(token.balance)
        ) {
          assetCount += 1;
        }
      }
    }
    return { assetCount, totalUsd };
  }, [walletBalances]);

  if (walletEnabled === false) {
    return null;
  }

  const hasAnyAddress = Boolean(evmAddress || solanaAddress);
  const hasAnyBalanceRow = walletSummary.assetCount > 0;

  return (
    <WidgetSection
      title="Wallet"
      icon={<Wallet className="h-3.5 w-3.5" />}
      testId="chat-widget-wallet-status"
      onTitleClick={() => setTab("inventory")}
    >
      {hasAnyAddress ? (
        <div className="flex flex-col gap-1.5 px-1 pt-0.5">
          {evmAddress ? (
            <div
              className="flex items-center justify-between gap-2 text-3xs"
              data-testid="chat-widget-wallet-row-evm-address"
            >
              <ChainBadges chains={evmChains} />
              <div className="flex items-center gap-1 min-w-0">
                <span
                  className="truncate font-mono text-txt"
                  title={evmAddress}
                >
                  {evmShort}
                </span>
                <CopyAddressButton value={evmAddress} label="EVM address" />
              </div>
            </div>
          ) : null}
          {solanaAddress ? (
            <div
              className="flex items-center justify-between gap-2 text-3xs"
              data-testid="chat-widget-wallet-row-solana-address"
            >
              <ChainBadge chain="solana" />
              <div className="flex items-center gap-1 min-w-0">
                <span
                  className="truncate font-mono text-txt"
                  title={solanaAddress}
                >
                  {solanaShort}
                </span>
                <CopyAddressButton
                  value={solanaAddress}
                  label="Solana address"
                />
              </div>
            </div>
          ) : null}

          {hasAnyBalanceRow ? (
            <div className="mt-1 flex flex-col gap-1 border-t border-border/20 pt-1.5">
              <div
                className="flex items-center justify-between text-3xs"
                data-testid="chat-widget-wallet-row-assets"
              >
                <span className="truncate text-muted">Assets</span>
                <span className="shrink-0 text-txt">
                  {walletSummary.assetCount}
                </span>
              </div>
              <div
                className="flex items-center justify-between text-3xs"
                data-testid="chat-widget-wallet-row-value"
              >
                <span className="truncate text-muted">Value</span>
                <span className="shrink-0 text-txt">
                  {formatUsd(walletSummary.totalUsd)}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <EmptyWidgetState
          icon={<Wallet className="h-5 w-5" />}
          title="No wallet addresses yet"
        />
      )}
    </WidgetSection>
  );
}

export const WALLET_STATUS_WIDGET: ChatSidebarWidgetDefinition = {
  id: "wallet.status",
  pluginId: "wallet",
  order: 70,
  defaultEnabled: true,
  Component: WalletStatusSidebarWidget,
};
