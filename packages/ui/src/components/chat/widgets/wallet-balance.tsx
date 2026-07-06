/**
 * WALLET home widget. A glanceable, chromeless tile on the orange home field
 * showing crypto **unit prices only** — never the amount held or the holding
 * value (#10706). Tapping opens the wallet view.
 *
 * Two states, always visible once prices load (#14344): when the user holds ≥1
 * priced token worth ≥ $1, the top-3 held by holding value; otherwise the
 * tracked BTC/SOL/ETH default rows (back-filled from trending movers if the
 * overview is partial). Prices refresh on a 60s document-visibility-gated
 * interval — no polling while the app is backgrounded. It self-hides only when
 * prices are unavailable (both endpoints down / never loaded): the home surface
 * shows no error chrome; the wallet view owns error state (J4).
 */

import type { WalletBalancesResponse } from "@elizaos/shared";
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
  selectDefaultPriceRows,
  selectPricedHoldings,
} from "./wallet-price-holdings";

/** Price refresh cadence; the server caches market overview 120s so this is cheap. */
const REFRESH_INTERVAL_MS = 60_000;

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
  const [holdings, setHoldings] = useState<PricedHolding[] | null>(null);
  const [loading, setLoading] = useState(true);
  const nav = useWidgetNavigation();
  // Auth gate (#11084): the widget mounts before the auth probe resolves, so
  // fetching stays dormant until the session is authenticated.
  const authenticated = useIsAuthenticated();
  const activeRef = useRef(true);
  const refreshSeqRef = useRef(0);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (authenticated) return;
    refreshSeqRef.current += 1;
    setHoldings(null);
    setLoading(true);
  }, [authenticated]);

  // Prices (BTC/SOL/ETH + trending) come from the market-overview endpoint;
  // balances decide the held-vs-default branch. Both are fetched together and
  // best-effort (J4): a null overview means prices are unavailable → hide; a
  // null balances alone still shows the default rows.
  const refresh = useCallback(async () => {
    refreshSeqRef.current += 1;
    const seq = refreshSeqRef.current;
    const [balances, overview] = await Promise.all([
      // error-policy:J4 balances failure ⇒ no held rows; default rows still show
      (client.getWalletBalances() as Promise<WalletBalancesResponse>).catch(
        () => null,
      ),
      // error-policy:J4 overview failure ⇒ no prices at all ⇒ widget hides
      client.getWalletMarketOverview().catch(() => null),
    ]);
    if (!activeRef.current || seq !== refreshSeqRef.current) return;
    const held = selectPricedHoldings(balances, overview?.prices);
    const next = held.length > 0 ? held : selectDefaultPriceRows(overview);
    // A failed refresh (next empty) keeps the last-good rows so a transient
    // outage does not flicker the tile out; only a first load with no prices
    // resolves to empty (→ hidden).
    setHoldings((prev) => (next.length > 0 ? next : (prev ?? [])));
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    void refresh();
  }, [authenticated, refresh]);

  // Visibility-gated refresh: no requests fire while the app is backgrounded.
  useIntervalWhenDocumentVisible(
    () => {
      void refresh();
    },
    REFRESH_INTERVAL_MS,
    authenticated,
  );

  if (!authenticated) return null;

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

  // Prices unavailable (overview never loaded / both endpoints down) → render
  // nothing rather than error chrome on the home surface (J4).
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
