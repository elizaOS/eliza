/**
 * WalletStatusCard — displays agent wallet addresses and token balances.
 */

import type { WalletAddresses, WalletBalancesResponse } from "@elizaos/shared";
import { Button, StatusBadge } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Check, Copy, Layers3, Network, Wallet } from "lucide-react";
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
  agentId,
  agentLabel,
}: {
  label: string;
  address: string;
  onCopy: (text: string, label: string) => void;
  agentId: string;
  agentLabel: string;
}) {
  const copy = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label: agentLabel,
    group: "vincent-wallet",
    description: `${agentLabel} to the clipboard`,
  });
  const shortAddress =
    address.length > 18
      ? `${address.slice(0, 6)}...${address.slice(-4)}`
      : address;

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border/30 bg-card/50 px-3 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-accent/20 bg-accent/10 text-accent">
          <Network className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-xs-tight font-semibold text-txt">{label}</div>
          <div className="mt-0.5 font-mono text-xs text-muted">
            {shortAddress}
          </div>
        </div>
      </div>
      <Button
        ref={copy.ref}
        {...copy.agentProps}
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 text-muted hover:text-txt"
        onClick={() => onCopy(address, label)}
        aria-label={`Copy ${label}`}
      >
        {label === "Copied!" ? (
          <Check className="h-3.5 w-3.5 text-ok" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}

function BalancePill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-[100px] flex-col items-start gap-0.5 rounded-lg border border-border/30 bg-card/60 px-3 py-2">
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
            label: chain.chain,
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
      balancePills: pills.sort(
        (a, b) =>
          Number.parseFloat(b.value.replace("$", "")) -
          Number.parseFloat(a.value.replace("$", "")),
      ),
    };
  }, [walletBalances]);

  const hasAddresses = evmAddress || solanaAddress;
  const visibleBalancePills = balancePills.slice(0, 4);
  const hiddenBalanceCount = Math.max(
    0,
    balancePills.length - visibleBalancePills.length,
  );

  if (!hasAddresses && !walletBalances) {
    return (
      <div
        data-testid="vincent-wallet-status-card"
        className="rounded-2xl border border-border/18 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_98%,transparent))] px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
      >
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-muted/50" />
          <span className="text-sm text-muted">Wallet loading</span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="vincent-wallet-status-card"
      className="space-y-3 rounded-2xl border border-border/18 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_98%,transparent))] px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
    >
      {/* Header row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold text-txt">Wallet</span>
        </div>
        {totalUsd && <StatusBadge label={totalUsd} tone="success" withDot />}
      </div>

      {/* Addresses */}
      {hasAddresses && (
        <div className="grid gap-2 sm:grid-cols-2">
          {evmAddress && (
            <CopyableAddress
              label={copiedField === "EVM" ? "Copied!" : "EVM"}
              address={evmAddress}
              onCopy={handleCopy}
              agentId="action-copy-evm-address"
              agentLabel="Copy EVM address"
            />
          )}
          {solanaAddress && (
            <CopyableAddress
              label={copiedField === "Solana" ? "Copied!" : "Solana"}
              address={solanaAddress}
              onCopy={handleCopy}
              agentId="action-copy-solana-address"
              agentLabel="Copy Solana address"
            />
          )}
        </div>
      )}

      {/* Balance pills — dust filtered */}
      {balancePills.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {visibleBalancePills.map((pill) => (
            <BalancePill
              key={pill.label}
              label={pill.label}
              value={pill.value}
            />
          ))}
          {hiddenBalanceCount > 0 ? (
            <div
              className="flex min-w-[100px] items-center justify-center gap-2 rounded-lg border border-border/30 bg-card/60 px-3 py-2 text-muted"
              title={`${hiddenBalanceCount} more balances`}
            >
              <Layers3 className="h-4 w-4" />
              <span className="text-sm font-semibold tabular-nums">
                +{hiddenBalanceCount}
              </span>
            </div>
          ) : null}
        </div>
      )}

      {/* No balances message */}
      {walletBalances && balancePills.length === 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-border/20 bg-card/45 px-3 py-2 text-xs text-muted">
          <span className="h-2 w-2 rounded-full bg-muted/50" />
          $0.01+
        </div>
      )}
    </div>
  );
}
