/**
 * WalletStatusCard — displays agent wallet addresses and token balances.
 */

import { Button, StatusBadge } from "@elizaos/ui";
import type { WalletAddresses, WalletBalancesResponse } from "@elizaos/shared";
import { Copy, Wallet } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

interface WalletStatusCardProps {
  walletAddresses: WalletAddresses | null;
  walletBalances: WalletBalancesResponse | null;
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
  ) => void;
}

function CopyableAddress({
  label,
  address,
  onCopy,
}: {
  label: string;
  address: string;
  onCopy: (text: string, label: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-bg/50 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-xs-tight font-medium text-muted">{label}</div>
        <div className="mt-0.5 truncate font-mono text-xs text-txt">
          {address}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 text-muted hover:text-txt"
        onClick={() => onCopy(address, label)}
        aria-label={`Copy ${label}`}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function BalancePill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-start gap-0.5 rounded-xl border border-border/30 bg-card/60 px-3 py-2 min-w-[100px]">
      <span className="text-2xs font-semibold uppercase tracking-wider text-muted/70">
        {label}
      </span>
      <span className="text-sm font-semibold tabular-nums text-txt">
        {value}
      </span>
    </div>
  );
}

/** Filter out dust balances (< $0.01 USD). */
function isNonDust(valueUsd: string): boolean {
  const n = Number.parseFloat(valueUsd);
  return Number.isFinite(n) && n >= 0.01;
}

export function WalletStatusCard({
  walletAddresses,
  walletBalances,
  setActionNotice,
}: WalletStatusCardProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const handleCopy = useCallback(
    (text: string, label: string) => {
      void navigator.clipboard.writeText(text).then(() => {
        setCopiedField(label);
        setActionNotice(`${label} copied`, "success", 2000);
        setTimeout(() => setCopiedField(null), 2000);
      });
    },
    [setActionNotice],
  );

  const evmAddress = walletAddresses?.evmAddress ?? null;
  const solanaAddress = walletAddresses?.solanaAddress ?? null;

  // Compute total USD value across all chains, filtering dust
  const { totalUsd, balancePills } = useMemo(() => {
    if (!walletBalances) return { totalUsd: null, balancePills: [] };

    let total = 0;
    const pills: Array<{ label: string; value: string }> = [];

    // EVM chains
    if (walletBalances.evm) {
      for (const chain of walletBalances.evm.chains) {
        if (isNonDust(chain.nativeValueUsd)) {
          total += Number.parseFloat(chain.nativeValueUsd);
          pills.push({
            label: `${chain.chain} Native`,
            value: `$${Number.parseFloat(chain.nativeValueUsd).toFixed(2)}`,
          });
        }
        for (const token of chain.tokens) {
          if (isNonDust(token.valueUsd)) {
            total += Number.parseFloat(token.valueUsd);
            pills.push({
              label: token.symbol,
              value: `$${Number.parseFloat(token.valueUsd).toFixed(2)}`,
            });
          }
        }
      }
    }

    // Solana
    if (walletBalances.solana) {
      if (isNonDust(walletBalances.solana.solValueUsd)) {
        total += Number.parseFloat(walletBalances.solana.solValueUsd);
        pills.push({
          label: "SOL",
          value: `$${Number.parseFloat(walletBalances.solana.solValueUsd).toFixed(2)}`,
        });
      }
      for (const token of walletBalances.solana.tokens) {
        if (isNonDust(token.valueUsd)) {
          total += Number.parseFloat(token.valueUsd);
          pills.push({
            label: token.symbol,
            value: `$${Number.parseFloat(token.valueUsd).toFixed(2)}`,
          });
        }
      }
    }

    return {
      totalUsd: total > 0 ? `$${total.toFixed(2)}` : null,
      balancePills: pills,
    };
  }, [walletBalances]);

  const hasAddresses = evmAddress || solanaAddress;

  if (!hasAddresses && !walletBalances) {
    return (
      <div
        data-testid="vincent-wallet-status-card"
        className="rounded-3xl border border-border/18 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_98%,transparent))] px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
      >
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-muted/50" />
          <span className="text-sm text-muted">Wallet data loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="vincent-wallet-status-card"
      className="rounded-3xl border border-border/18 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_98%,transparent))] px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] space-y-4"
    >
      {/* Header row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold text-txt">Agent Wallet</span>
        </div>
        {totalUsd && <StatusBadge label={totalUsd} tone="success" withDot />}
      </div>

      {/* Addresses */}
      {hasAddresses && (
        <div className="space-y-2">
          {evmAddress && (
            <CopyableAddress
              label={copiedField === "EVM Address" ? "Copied!" : "EVM Address"}
              address={evmAddress}
              onCopy={handleCopy}
            />
          )}
          {solanaAddress && (
            <CopyableAddress
              label={
                copiedField === "Solana Address" ? "Copied!" : "Solana Address"
              }
              address={solanaAddress}
              onCopy={handleCopy}
            />
          )}
        </div>
      )}

      {/* Balance pills — dust filtered */}
      {balancePills.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {balancePills.map((pill) => (
            <BalancePill
              key={pill.label}
              label={pill.label}
              value={pill.value}
            />
          ))}
        </div>
      )}

      {/* No balances message */}
      {walletBalances && balancePills.length === 0 && (
        <p className="text-xs text-muted">No token balances above $0.01.</p>
      )}
    </div>
  );
}
