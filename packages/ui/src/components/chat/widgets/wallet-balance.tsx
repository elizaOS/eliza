/**
 * WALLET "Balance" home widget. A glanceable, naked tile on the orange home
 * field showing one datum — aggregate portfolio value in USD — plus a count of
 * the chains that contribute to it. Tapping opens the full wallet view.
 *
 * Balance-gated (not account-gated): when neither EVM nor Solana balances are
 * present (or both sum to zero), the widget renders nothing rather than a
 * connect affordance — an empty wallet is not actionable here.
 */

import type { EvmChainBalance, WalletBalancesResponse } from "@elizaos/shared";
import { Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { client } from "../../../api";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

const DEFAULT_SPAN = "col-span-2 row-span-1";

interface WalletWidgetData {
  totalUsd: number;
  /** Number of chains/networks that hold a non-zero balance. */
  chainCount: number;
}

/** Network input → finite number; malformed/NaN strings degrade to 0. */
function parseUsd(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** USD held on one EVM chain: native value plus every token value. */
function evmChainUsd(chain: EvmChainBalance): number {
  let total = parseUsd(chain.nativeValueUsd);
  for (const token of chain.tokens) total += parseUsd(token.valueUsd);
  return total;
}

/**
 * Fetch-boundary aggregation. Sums total USD across Solana (SOL + SPL tokens)
 * and every EVM chain (native + tokens), and counts the distinct networks that
 * carry a positive balance (Solana as one, each contributing EVM chain as one).
 */
function summarize(response: WalletBalancesResponse): WalletWidgetData {
  let totalUsd = 0;
  let chainCount = 0;

  const { solana, evm } = response;
  if (solana) {
    let solanaUsd = parseUsd(solana.solValueUsd);
    for (const token of solana.tokens) solanaUsd += parseUsd(token.valueUsd);
    totalUsd += solanaUsd;
    if (solanaUsd > 0) chainCount += 1;
  }
  if (evm) {
    for (const chain of evm.chains) {
      const chainUsd = evmChainUsd(chain);
      totalUsd += chainUsd;
      if (chainUsd > 0) chainCount += 1;
    }
  }

  return { totalUsd, chainCount };
}

function formatUsd(value: number): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

export function WalletBalanceWidget(
  props: Partial<WidgetProps>,
): React.JSX.Element | null {
  const spanClassName = props.spanClassName ?? DEFAULT_SPAN;
  const [data, setData] = useState<WalletWidgetData | null>(null);
  const [loading, setLoading] = useState(true);
  const nav = useWidgetNavigation();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await client.getWalletBalances();
        if (cancelled) return;
        setData(summarize(response));
      } catch {
        // Wallet endpoint unreachable or errored: there is no balance to
        // surface, so fall through to the balance-gated empty state (renders
        // nothing) rather than letting the rejection escape.
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // First load pending: a quiet placeholder tile keeps the grid cell stable.
  if (loading && data == null) {
    return (
      <div
        data-testid="chat-widget-wallet-balance-loading"
        aria-busy="true"
        className={`${spanClassName} h-12 animate-pulse`}
      />
    );
  }

  // Balance-gated empty: no wallet value to surface → render nothing (per brief,
  // null is acceptable here; the wallet view is still reachable elsewhere).
  if (data == null || data.totalUsd <= 0) return null;

  const value = formatUsd(data.totalUsd);
  const chainBadge =
    data.chainCount > 0
      ? `${data.chainCount} ${data.chainCount === 1 ? "chain" : "chains"}`
      : undefined;

  return (
    <div className={spanClassName}>
      <HomeWidgetCard
        icon={<Wallet />}
        label="Wallet"
        value={value}
        badge={chainBadge}
        testId="chat-widget-wallet-balance"
        ariaLabel={`Wallet balance ${value} across ${data.chainCount} ${
          data.chainCount === 1 ? "chain" : "chains"
        }. Open wallet.`}
        onActivate={() => nav.openView("/wallet", "wallet")}
      />
    </div>
  );
}
