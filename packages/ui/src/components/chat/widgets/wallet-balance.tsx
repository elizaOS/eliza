/**
 * WALLET home widget. A glanceable, chromeless tile on the ember home field
 * showing crypto **unit prices only** - never the amount held or the holding
 * value (#10706). Tapping opens the wallet view.
 *
 * Three states keep loading, unavailable data, and confirmed holdings distinct.
 * Once balances and prices load, the widget shows either the top-3 held tokens
 * worth ≥ $1 or tracked BTC/SOL/ETH defaults for a confirmed-empty wallet.
 * Prices refresh on a 60s document-visibility-gated interval; an unavailable
 * first load renders a compact route to the wallet's detailed error state.
 */

import type { WalletBalancesResponse } from "@elizaos/shared";
import { Wallet } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../../api";
import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import { useIntervalWhenDocumentVisible } from "../../../hooks/useDocumentVisibility";
import type { WidgetProps } from "../../../widgets/types";
import { Button } from "../../ui/button";
import {
  HOME_WIDGET_SOLID_TILE_CLASS,
  useWidgetNavigation,
} from "./home-widget-card";
import {
  type PricedHolding,
  selectDefaultPriceRows,
  selectPricedHoldings,
} from "./wallet-price-holdings";

/** Price refresh cadence; the server caches market overview 120s so this is cheap. */
const REFRESH_INTERVAL_MS = 60_000;

const DEFAULT_SPAN = "col-span-2 row-span-1";

type RefreshResult<T> = { ok: true; value: T } | { ok: false };

type WalletDisplayState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; holdings: PricedHolding[] };

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
    // error-policy:J3 Intl rejected the locale/currency - plain formatting
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
  const [displayState, setDisplayState] = useState<WalletDisplayState>({
    status: "loading",
  });
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
    setDisplayState({ status: "loading" });
  }, [authenticated]);

  // Prices (BTC/SOL/ETH + trending) come from the market-overview endpoint;
  // balances decide the held-vs-default branch. Both are fetched together and
  // best-effort (J4): either unavailable response hides the initial tile rather
  // than presenting an unknown wallet as an empty wallet.
  const refresh = useCallback(async () => {
    refreshSeqRef.current += 1;
    const seq = refreshSeqRef.current;
    const [balancesResult, overviewResult] = await Promise.all([
      (client.getWalletBalances() as Promise<WalletBalancesResponse>)
        .then<RefreshResult<WalletBalancesResponse>>((value) => ({
          ok: true,
          value,
        }))
        .catch<RefreshResult<WalletBalancesResponse>>(() => ({
          // error-policy:J4 balances unavailable means holdings are unknown; do
          // not fabricate "empty wallet" default rows.
          ok: false,
        })),
      client
        .getWalletMarketOverview()
        .then<
          RefreshResult<
            Awaited<ReturnType<typeof client.getWalletMarketOverview>>
          >
        >((value) => ({ ok: true, value }))
        .catch<
          RefreshResult<
            Awaited<ReturnType<typeof client.getWalletMarketOverview>>
          >
        >(() => ({
          // error-policy:J4 overview failure ⇒ no prices at all ⇒ widget hides
          ok: false,
        })),
    ]);
    if (!activeRef.current || seq !== refreshSeqRef.current) return;
    if (!overviewResult.ok || !balancesResult.ok) {
      // A transient failure keeps a prior ready state. On first load, J4
      // requires a visible unavailable state rather than loading forever or
      // fabricating an empty wallet.
      setDisplayState((previous) =>
        previous.status === "ready" ? previous : { status: "unavailable" },
      );
      return;
    }
    const held = selectPricedHoldings(
      balancesResult.value,
      overviewResult.value.prices,
    );
    setDisplayState({
      status: "ready",
      holdings:
        held.length > 0 ? held : selectDefaultPriceRows(overviewResult.value),
    });
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
  if (displayState.status === "loading") {
    return (
      <div
        data-testid="chat-widget-wallet-balance-loading"
        aria-busy="true"
        className={`${spanClassName} h-12 animate-pulse`}
      />
    );
  }

  if (displayState.status === "unavailable") {
    return (
      <Button
        data-testid="chat-widget-wallet-unavailable"
        aria-label="Wallet data unavailable. Open wallet."
        onClick={() => nav.openView("/wallet", "wallet")}
        variant="ghost"
        className={`${spanClassName} ${HOME_WIDGET_SOLID_TILE_CLASS} items-center justify-between gap-3 px-3 py-2.5 font-normal transition-[background-color,border-color,opacity] hover:border-[color:color-mix(in_srgb,var(--brand-white)_34%,var(--brand-black))] hover:bg-[var(--brand-black)] hover:opacity-90`}
      >
        <span className="flex items-center gap-2 text-xs text-[color:color-mix(in_srgb,var(--brand-white)_68%,transparent)] [&>svg]:h-3.5 [&>svg]:w-3.5">
          <Wallet />
          Wallet
        </span>
        <span className="text-xs text-[var(--brand-white)]">Unavailable</span>
      </Button>
    );
  }

  const { holdings } = displayState;
  if (holdings.length === 0) return null;

  return (
    <Button
      data-testid="chat-widget-wallet-prices"
      aria-label={`Wallet prices: ${holdings
        .map((h) => `${h.symbol} ${formatPrice(h.priceUsd)}`)
        .join(", ")}. Open wallet.`}
      onClick={() => nav.openView("/wallet", "wallet")}
      variant="ghost"
      className={`${spanClassName} ${HOME_WIDGET_SOLID_TILE_CLASS} flex-col items-stretch gap-1 px-3 py-2.5 font-normal transition-[background-color,border-color,opacity] hover:border-[color:color-mix(in_srgb,var(--brand-white)_34%,var(--brand-black))] hover:bg-[var(--brand-black)] hover:opacity-90`}
    >
      <span className="flex items-center gap-2 text-xs text-[color:color-mix(in_srgb,var(--brand-white)_68%,transparent)] [&>svg]:h-3.5 [&>svg]:w-3.5">
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
            <span className="truncate font-medium text-[var(--brand-white)]">
              {h.symbol}
            </span>
            <span className="flex shrink-0 items-baseline gap-1.5">
              <span className="tabular-nums text-[var(--brand-white)]">
                {formatPrice(h.priceUsd)}
              </span>
              {change ? (
                <span className="tabular-nums text-xs text-[color:color-mix(in_srgb,var(--brand-white)_82%,transparent)]">
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
