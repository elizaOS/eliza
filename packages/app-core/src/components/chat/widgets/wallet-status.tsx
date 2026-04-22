/**
 * Compact wallet-status widget for the chat-sidebar.
 *
 * Surfaces a one-glance summary of the user's wallet so the right rail can
 * mirror what /wallet would show without the full panel:
 *   - Short EVM + Solana addresses with copy-to-clipboard buttons
 *   - Per-chain aggregated USD balance rows; rows below $0.01 are hidden
 *     entirely so the widget stays quiet when nothing material is held
 *
 * Title-click opens the full /wallet (inventory) view.
 */

import { Check, Copy, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { EvmChainBalance } from "@elizaos/shared/contracts/wallet";
import { useApp } from "../../../state";
import {
  type ChatSidebarWidgetDefinition,
  type ChatSidebarWidgetProps,
} from "./types";
import { EmptyWidgetState, WidgetSection } from "./shared";

const DUST_THRESHOLD_USD = 0.01;
const COPY_FEEDBACK_MS = 1200;

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

function chainLabel(chain: string): string {
  if (!chain) return "Chain";
  return chain.charAt(0).toUpperCase() + chain.slice(1);
}

function chainTotalUsd(chain: EvmChainBalance): number {
  const nativeUsd = parseUsd(chain.nativeValueUsd);
  const tokenUsd = chain.tokens.reduce(
    (sum, token) => sum + parseUsd(token.valueUsd),
    0,
  );
  return nativeUsd + tokenUsd;
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
      // Silent — browsers without clipboard permission just no-op.
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
  const { walletEnabled, walletAddresses, walletBalances, loadBalances, setTab } =
    useApp();

  // Auto-fetch balances when the widget first mounts if nothing is cached.
  // `loadBalances` is a stable useCallback on the app context.
  useEffect(() => {
    if (walletEnabled === false) return;
    if (walletBalances !== null) return;
    void loadBalances();
    // Intentionally no interval — /wallet is the polling surface. The widget
    // refreshes whenever the user opens that page or something else mutates
    // walletBalances in shared state.
  }, [walletEnabled, walletBalances, loadBalances]);

  const evmAddress = walletAddresses?.evmAddress ?? null;
  const solanaAddress = walletAddresses?.solanaAddress ?? null;
  const evmShort = shortenAddress(evmAddress);
  const solanaShort = shortenAddress(solanaAddress);

  const evmChainRows = useMemo(() => {
    if (!walletBalances?.evm) return [] as Array<{ chain: string; usd: number }>;
    return walletBalances.evm.chains
      .map((chain) => ({ chain: chain.chain, usd: chainTotalUsd(chain) }))
      .filter((entry) => entry.usd >= DUST_THRESHOLD_USD)
      .sort((a, b) => b.usd - a.usd);
  }, [walletBalances]);

  const solanaTotalUsd = useMemo(() => {
    if (!walletBalances?.solana) return 0;
    const native = parseUsd(walletBalances.solana.solValueUsd);
    const tokens = walletBalances.solana.tokens.reduce(
      (sum, token) => sum + parseUsd(token.valueUsd),
      0,
    );
    return native + tokens;
  }, [walletBalances]);
  const showSolanaRow = solanaTotalUsd >= DUST_THRESHOLD_USD;

  if (walletEnabled === false) {
    return null;
  }

  const hasAnyAddress = Boolean(evmAddress || solanaAddress);
  const hasAnyBalanceRow = evmChainRows.length > 0 || showSolanaRow;

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
              <span className="text-muted">EVM</span>
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
              <span className="text-muted">Solana</span>
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
              {evmChainRows.map((row) => (
                <div
                  key={row.chain}
                  className="flex items-center justify-between text-3xs"
                  data-testid={`chat-widget-wallet-row-balance-${row.chain}`}
                >
                  <span className="truncate text-muted">
                    {chainLabel(row.chain)}
                  </span>
                  <span className="shrink-0 text-txt">
                    {formatUsd(row.usd)}
                  </span>
                </div>
              ))}
              {showSolanaRow ? (
                <div
                  className="flex items-center justify-between text-3xs"
                  data-testid="chat-widget-wallet-row-balance-solana"
                >
                  <span className="truncate text-muted">Solana</span>
                  <span className="shrink-0 text-txt">
                    {formatUsd(solanaTotalUsd)}
                  </span>
                </div>
              ) : null}
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
