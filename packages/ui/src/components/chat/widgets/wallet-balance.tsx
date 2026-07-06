/**
 * WALLET home widget. A glanceable, chromeless tile on the orange home field
 * listing cryptocurrencies by **unit price only** — never the amount held or
 * the holding value (#10706). Tapping opens the wallet view.
 *
 * Doctrine (#14344): the widget is a resting-home keeper, so it shows the user's
 * top-3 priced holdings when they hold ≥1 qualifying asset (≥ $1 with a market
 * price), and otherwise the BTC/SOL/ETH baseline — it does not hide on an empty
 * wallet. Prices are refreshed on a 60s visibility-gated interval (the
 * market-overview route is cached server-side, so the poll is cheap). The tile
 * self-hides ONLY when both the balances and overview endpoints are
 * unavailable; the wallet view itself owns the visible error state (J4).
 */

import type {
  WalletBalancesResponse,
  WalletMarketOverviewResponse,
} from "@elizaos/shared";
import { Wallet } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../../api";
import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import { useIntervalWhenDocumentVisible } from "../../../hooks/useDocumentVisibility";
import type { WidgetProps } from "../../../widgets/types";
import { Button } from "../../ui/button";
import { useWidgetNavigation } from "./home-widget-card";
import {
  type PricedHolding,
  selectWalletWidgetRows,
} from "./wallet-price-holdings";

const DEFAULT_SPAN = "col-span-2 row-span-1";

/** Price refresh cadence while the home is foregrounded (server cache = 120s). */
const WALLET_REFRESH_INTERVAL_MS = 60_000;

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
    // error-policy:J3 Intl rejected the locale/currency — plain formatting
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
  const [rows, setRows] = useState<PricedHolding[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const nav = useWidgetNavigation();
  // Auth gate (#11084): the widget mounts before the auth probe resolves, so
  // the balances/overview fetch must stay dormant until the session is
  // authenticated (it fires once the phase flips).
  const authenticated = useIsAuthenticated();
  // Guards against a state write after unmount when a poll is in flight.
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    // The two endpoints fail independently: a balances outage still leaves the
    // BTC/SOL/ETH baseline from the overview, and vice versa. selectWalletWidgetRows
    // returns [] only when both are null, which is the sole self-hide case.
    // error-policy:J4 designed home-surface degrade — the wallet view owns the
    // visible error state; the home tile never renders error chrome.
    const [balances, overview] = await Promise.all([
      client
        .getWalletBalances()
        .catch(() => null) as Promise<WalletBalancesResponse | null>,
      client
        .getWalletMarketOverview()
        .catch(() => null) as Promise<WalletMarketOverviewResponse | null>,
    ]);
    if (!activeRef.current) return;
    setRows(selectWalletWidgetRows(balances, overview));
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    void load();
  }, [authenticated, load]);

  useIntervalWhenDocumentVisible(() => {
    if (authenticated) void load();
  }, WALLET_REFRESH_INTERVAL_MS);

  // First load pending: a quiet placeholder keeps the grid cell stable.
  if (!loaded && rows == null) {
    return (
      <div
        data-testid="chat-widget-wallet-balance-loading"
        aria-busy="true"
        className={`${spanClassName} h-12 animate-pulse`}
      />
    );
  }

  // Both endpoints unavailable → nothing to show; self-hide without error chrome.
  if (!rows || rows.length === 0) return null;

  return (
    <Button
      data-testid="chat-widget-wallet-prices"
      aria-label={`Wallet prices: ${rows
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
      {rows.map((h) => {
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
