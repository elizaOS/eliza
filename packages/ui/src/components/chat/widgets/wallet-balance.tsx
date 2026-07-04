/**
 * WALLET home widget. A glanceable, chromeless tile on the orange home field
 * listing the top cryptocurrencies the user HOLDS by **unit price only** — never
 * the amount held or the holding value (#10706). Tapping opens the wallet view.
 *
 * Holdings-gated: when there is no qualifying priced holding (nothing held worth
 * ≥ $1 that also has a market price), the widget renders nothing rather than a
 * connect affordance — an empty wallet is not actionable here.
 */

import type { WalletBalancesResponse } from "@elizaos/shared";
import { Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { client } from "../../../api";
import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import type { WidgetProps } from "../../../widgets/types";
import { Button } from "../../ui/button";
import { useWidgetNavigation } from "./home-widget-card";
import {
  type PricedHolding,
  selectPricedHoldings,
} from "./wallet-price-holdings";

const DEFAULT_SPAN = "col-span-2 row-span-1";

/** Format a unit price: more decimals for sub-dollar assets, 2 for the rest. */
function formatPrice(priceUsd: number): string {
  const digits = priceUsd > 0 && priceUsd < 1 ? 6 : 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: digits,
    }).format(priceUsd);
  } catch {
    return `$${priceUsd.toFixed(digits)}`;
  }
}

/** Signed 24h-change label, e.g. "+1.2%" / "-0.4%"; empty when ~0. */
function formatChange(change24hPct: number): string {
  if (!Number.isFinite(change24hPct) || Math.abs(change24hPct) < 0.01)
    return "";
  const sign = change24hPct > 0 ? "+" : "";
  return `${sign}${change24hPct.toFixed(1)}%`;
}

export function WalletBalanceWidget(
  props: Partial<WidgetProps>,
): React.JSX.Element | null {
  const spanClassName = props.spanClassName ?? DEFAULT_SPAN;
  const [holdings, setHoldings] = useState<PricedHolding[] | null>(null);
  const [loading, setLoading] = useState(true);
  const nav = useWidgetNavigation();
  // Auth gate (#11084): the widget mounts before the auth probe resolves, so
  // the one-shot balances/prices fetch must stay dormant until the session is
  // authenticated (it fires once the phase flips).
  const authenticated = useIsAuthenticated();

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    void (async () => {
      try {
        // Prices come from a separate endpoint; fetch both together. The widget
        // shows prices only, so a balances failure means "nothing to show".
        const [balances, overview] = await Promise.all([
          client.getWalletBalances() as Promise<WalletBalancesResponse>,
          client.getWalletMarketOverview().catch(() => null),
        ]);
        if (cancelled) return;
        setHoldings(selectPricedHoldings(balances, overview?.prices));
      } catch {
        // error-policy:J4 home-grid tiles self-hide rather than surface error
        // chrome (designed home-surface degrade); the wallet page itself owns
        // the visible error state for a broken balances endpoint.
        if (!cancelled) setHoldings(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated]);

  // First load pending: a quiet placeholder keeps the grid cell stable.
  if (loading && holdings == null) {
    return (
      <div
        data-testid="chat-widget-wallet-balance-loading"
        aria-busy="true"
        className={`${spanClassName} h-12 animate-pulse`}
      />
    );
  }

  // Holdings-gated empty: no qualifying priced holding → render nothing.
  if (!holdings || holdings.length === 0) return null;

  return (
    <Button
      data-testid="chat-widget-wallet-prices"
      aria-label={`Wallet prices: ${holdings
        .map((h) => `${h.symbol} ${formatPrice(h.priceUsd)}`)
        .join(", ")}. Open wallet.`}
      onClick={() => nav.openView("/wallet", "wallet")}
      variant="ghost"
      className={`${spanClassName} group flex h-auto w-full flex-col items-stretch gap-1 whitespace-normal px-3 py-2.5 text-left font-normal transition-opacity hover:opacity-80`}
    >
      <span className="flex items-center gap-2 text-xs text-muted [&>svg]:h-3.5 [&>svg]:w-3.5">
        <Wallet />
        Wallet
      </span>
      {holdings.map((h) => {
        const change = formatChange(h.change24hPct);
        return (
          <span
            key={h.symbol}
            data-testid={`wallet-price-row-${h.symbol}`}
            className="flex items-baseline justify-between gap-2 text-sm"
          >
            <span className="truncate font-medium text-txt-strong">
              {h.symbol}
            </span>
            <span className="flex shrink-0 items-baseline gap-1.5">
              <span className="tabular-nums text-txt-strong">
                {formatPrice(h.priceUsd)}
              </span>
              {change ? (
                <span
                  className={`tabular-nums text-xs ${
                    h.change24hPct >= 0 ? "text-success" : "text-danger"
                  }`}
                >
                  {change}
                </span>
              ) : null}
            </span>
          </span>
        );
      })}
    </Button>
  );
}
