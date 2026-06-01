import type { OverlayAppContext } from "@elizaos/app-core";
import { Button, client, PagePanel, Spinner } from "@elizaos/app-core";
import { useAgentElement } from "@elizaos/ui";
import {
  ArrowLeft,
  CheckCircle2,
  LockKeyhole,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import "./client";
import type { PolymarketClient } from "./client";
import type {
  PolymarketDisabledResponse,
  PolymarketMarket,
  PolymarketMarketsResponse,
  PolymarketOrderbookResponse,
  PolymarketPositionsResponse,
  PolymarketStatusResponse,
} from "./polymarket-contracts";
import { usePolymarketState } from "./usePolymarketState";

export function PolymarketAppView({ exitToApps, t }: OverlayAppContext) {
  const {
    status,
    markets,
    selectedMarket,
    setSelectedMarket,
    loading,
    error,
    refresh,
  } = usePolymarketState();

  const backLabel = t("nav.back", { defaultValue: "Back" });
  const refreshLabel = t("actions.refresh", { defaultValue: "Refresh" });
  const back = useAgentElement<HTMLButtonElement>({
    id: "action-back",
    role: "button",
    label: backLabel,
    group: "polymarket-nav",
    description: "Exit Polymarket and return to the apps list",
  });
  const refreshControl = useAgentElement<HTMLButtonElement>({
    id: "action-refresh",
    role: "button",
    label: refreshLabel,
    group: "polymarket-nav",
    description: "Reload Polymarket status and active markets",
  });

  return (
    <div
      data-testid="polymarket-shell"
      className="fixed inset-0 z-50 flex h-[100vh] flex-col overflow-hidden bg-bg supports-[height:100dvh]:h-[100dvh]"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border/20 bg-bg/80 px-4 py-3 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            ref={back.ref}
            {...back.agentProps}
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 rounded-xl text-muted hover:text-txt"
            onClick={exitToApps}
            aria-label={backLabel}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-txt">
              Polymarket
            </h1>
            <div className="mt-1 flex gap-1.5">
              <MiniBadge label="Markets" />
              <MiniBadge label="CLOB gate" />
            </div>
          </div>
        </div>

        <Button
          ref={refreshControl.ref}
          {...refreshControl.agentProps}
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-xl text-muted hover:text-txt"
          onClick={refresh}
          disabled={loading}
          aria-label={refreshLabel}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="chat-native-scrollbar flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
          <section className="space-y-3">
            {error && (
              <PagePanel.Notice tone="danger">{error}</PagePanel.Notice>
            )}

            <div className="rounded-lg border border-border/20 bg-bg-accent/60 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-txt">
                    Read access
                  </h2>
                </div>
                <StatusPill ready={status?.publicReads.ready ?? false} />
              </div>
            </div>

            <div className="rounded-lg border border-border/20 bg-bg-accent/60 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-txt">
                    Trading readiness
                  </h2>
                </div>
                <StatusPill ready={status?.trading.ready ?? false} />
              </div>
              {status?.trading.missing.length ? (
                <div className="mt-3 flex items-start gap-2 rounded-md border border-warn/25 bg-warn/10 p-3 text-xs text-muted">
                  <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
                  <span>{status.trading.reason}</span>
                </div>
              ) : null}
            </div>

            <div className="overflow-hidden rounded-lg border border-border/20 bg-bg-accent/60">
              <div className="border-b border-border/20 px-4 py-3">
                <h2 className="text-sm font-semibold text-txt">
                  Active markets
                </h2>
              </div>
              {loading && markets.length === 0 ? (
                <div className="flex items-center gap-3 p-4 text-sm text-muted">
                  <Spinner className="h-4 w-4" />
                  <span>Loading markets…</span>
                </div>
              ) : (
                <div className="max-h-[55vh] divide-y divide-border/15 overflow-y-auto">
                  {markets.map((market) => (
                    <MarketListItem
                      key={market.id}
                      market={market}
                      active={selectedMarket?.id === market.id}
                      onSelect={setSelectedMarket}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="min-w-0 rounded-lg border border-border/20 bg-bg-accent/60 p-5">
            {selectedMarket ? (
              <div>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-normal text-muted">
                      {selectedMarket.category ?? "Market"}
                    </p>
                    <h2 className="mt-2 text-xl font-semibold leading-tight text-txt">
                      {selectedMarket.question ?? selectedMarket.slug}
                    </h2>
                  </div>
                  <StatusPill ready={selectedMarket.active === true} />
                </div>

                {selectedMarket.description ? (
                  <p className="mt-4 text-sm leading-relaxed text-muted">
                    {selectedMarket.description}
                  </p>
                ) : null}

                <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Metric label="Liquidity" value={selectedMarket.liquidity} />
                  <Metric label="Volume" value={selectedMarket.volume} />
                  <Metric
                    label="Last trade"
                    value={selectedMarket.lastTradePrice}
                  />
                </div>

                <div className="mt-5 overflow-hidden rounded-lg border border-border/20">
                  <div className="border-b border-border/20 px-4 py-3 text-sm font-semibold text-txt">
                    Outcomes
                  </div>
                  <div className="divide-y divide-border/15">
                    {selectedMarket.outcomes.map((outcome) => (
                      <div
                        key={outcome.name}
                        className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                      >
                        <span className="min-w-0 flex-1 truncate font-medium text-txt">
                          {outcome.name}
                        </span>
                        <span className="shrink-0 text-muted">
                          {outcome.price ?? "n/a"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-64 items-center justify-center text-sm text-muted">
                No Polymarket market selected.
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function MarketListItem({
  market,
  active,
  onSelect,
}: {
  market: PolymarketMarket;
  active: boolean;
  onSelect: (market: PolymarketMarket) => void;
}) {
  const label = market.question ?? market.slug ?? market.id;
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `market-${market.id}`,
    role: "list-item",
    label,
    group: "polymarket-markets",
    status: active ? "active" : "inactive",
    description: `Select the ${label} market`,
  });
  return (
    <button
      ref={ref}
      {...agentProps}
      type="button"
      onClick={() => onSelect(market)}
      aria-current={active ? "true" : undefined}
      className={`block w-full px-4 py-3 text-left hover:bg-bg ${
        active ? "bg-bg" : ""
      }`}
    >
      <span className="line-clamp-2 text-sm font-medium text-txt">{label}</span>
      <span className="mt-1 block text-xs text-muted">
        {market.volume24hr
          ? `24h volume ${market.volume24hr}`
          : (market.category ?? "Market")}
      </span>
    </button>
  );
}

function StatusPill({ ready }: { ready: boolean }) {
  return (
    <span
      title={ready ? "Ready" : "Disabled"}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs-tight font-semibold ${
        ready
          ? "border-ok/35 bg-ok/12 text-ok"
          : "border-border bg-bg text-muted"
      }`}
    >
      {ready ? (
        <CheckCircle2 className="h-3.5 w-3.5" />
      ) : (
        <XCircle className="h-3.5 w-3.5" />
      )}
      <span className="sr-only">{ready ? "Ready" : "Disabled"}</span>
    </span>
  );
}

function MiniBadge({ label }: { label: string }) {
  return (
    <span className="rounded-md border border-border/40 bg-bg-accent px-1.5 py-0.5 text-2xs font-medium text-muted">
      {label}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-lg border border-border/20 bg-bg p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-txt">
        {value ?? "n/a"}
      </div>
    </div>
  );
}

async function loadPolymarketTuiState(user?: string): Promise<{
  status: PolymarketStatusResponse;
  markets: PolymarketMarketsResponse;
  orders: PolymarketDisabledResponse;
  positions: PolymarketPositionsResponse | null;
}> {
  const polymarketClient = client as PolymarketClient;
  const [status, markets, orders] = await Promise.all([
    polymarketClient.polymarketStatus(),
    polymarketClient.polymarketMarkets({ limit: 25 }),
    polymarketClient.polymarketOrders(),
  ]);
  const positions = user
    ? await polymarketClient.polymarketPositions(user)
    : null;
  return { status, markets, orders, positions };
}

async function postPolymarketCommand(
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof data === "object" &&
      data !== null &&
      "error" in data &&
      typeof data.error === "string"
        ? data.error
        : `Polymarket request failed with ${response.status}`;
    throw new Error(message);
  }
  return data;
}

export function PolymarketTuiView() {
  const [state, setState] = useState<Awaited<
    ReturnType<typeof loadPolymarketTuiState>
  > | null>(null);
  const [selectedMarket, setSelectedMarket] = useState<PolymarketMarket | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [lastAction, setLastAction] = useState("boot");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadPolymarketTuiState();
      setState(next);
      setSelectedMarket(
        (current) => current ?? next.markets.markets[0] ?? null,
      );
      setLastAction("refresh");
    } catch (caught) {
      setState(null);
      setSelectedMarket(null);
      setError(
        caught instanceof Error ? caught.message : "Polymarket refresh failed",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const viewState = {
    viewType: "tui",
    viewId: "polymarket",
    publicReadReady: state?.status.publicReads.ready ?? false,
    tradingReady: state?.status.trading.ready ?? false,
    marketCount: state?.markets.markets.length ?? 0,
    selectedMarketId: selectedMarket?.id ?? null,
    ordersEnabled: state?.orders.enabled ?? false,
    positionCount: state?.positions?.positions.length ?? 0,
    loading,
    lastAction,
    error,
  };

  return (
    <div
      data-view-state={JSON.stringify(viewState)}
      style={{
        minHeight: "100vh",
        background: "#020617",
        color: "#cbd5e1",
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        padding: 20,
      }}
    >
      <div style={{ color: "#7dd3fc", marginBottom: 4 }}>
        elizaos://polymarket --type=tui
      </div>
      <div style={{ color: "#475569", marginBottom: 16 }}>
        {loading
          ? "loading"
          : state?.status.publicReads.ready
            ? "read-ready"
            : "read-blocked"}{" "}
        | {state?.markets.markets.length ?? 0} markets | trading{" "}
        {state?.status.trading.ready ? "ready" : "disabled"} | {lastAction}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(320px, 1fr) minmax(320px, 1fr)",
          gap: 16,
        }}
      >
        <section
          aria-label="Polymarket markets"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
            borderRadius: 6,
            padding: 16,
            minHeight: 420,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <strong style={{ color: "#e2e8f0" }}>active markets</strong>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              style={{
                background: "transparent",
                color: "#a7f3d0",
                border: "1px solid rgba(167,243,208,0.45)",
                borderRadius: 4,
                padding: "4px 8px",
                cursor: loading ? "not-allowed" : "pointer",
                fontFamily: "inherit",
              }}
            >
              refresh
            </button>
          </div>
          {error && <div style={{ color: "#fca5a5" }}>{error}</div>}
          {(state?.markets.markets ?? []).map((market, index) => (
            <button
              key={market.id}
              type="button"
              onClick={() => setSelectedMarket(market)}
              style={{
                display: "grid",
                gridTemplateColumns: "4ch minmax(0,1fr) 10ch",
                gap: 10,
                width: "100%",
                border: "none",
                borderTop:
                  index === 0 ? "none" : "1px solid rgba(125,211,252,0.18)",
                background:
                  selectedMarket?.id === market.id
                    ? "rgba(125,211,252,0.08)"
                    : "transparent",
                color: "inherit",
                padding: "9px 0",
                textAlign: "left",
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              <span style={{ color: "#64748b" }}>
                {String(index + 1).padStart(2, "0")}
              </span>
              <span style={{ color: "#e2e8f0", overflow: "hidden" }}>
                {market.question ?? market.slug ?? market.id}
              </span>
              <span style={{ color: market.active ? "#a7f3d0" : "#94a3b8" }}>
                {market.active ? "active" : "closed"}
              </span>
              <span style={{ gridColumn: "2 / 4", color: "#94a3b8" }}>
                vol {market.volume ?? "n/a"} / liq {market.liquidity ?? "n/a"}
              </span>
            </button>
          ))}
        </section>

        <section
          aria-label="Polymarket market details"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
            borderRadius: 6,
            padding: 16,
            minHeight: 420,
          }}
        >
          <strong style={{ color: "#e2e8f0" }}>market detail</strong>
          <div style={{ color: "#64748b", margin: "6px 0 14px" }}>
            commands: state | market | orderbook | positions | trading-check
          </div>
          {selectedMarket ? (
            <>
              <div style={{ color: "#e2e8f0", marginBottom: 8 }}>
                {selectedMarket.question ?? selectedMarket.slug}
              </div>
              <div style={{ color: "#94a3b8", marginBottom: 12 }}>
                {selectedMarket.description ??
                  selectedMarket.category ??
                  "No description"}
              </div>
              <div style={{ color: "#a7f3d0", marginBottom: 8 }}>outcomes</div>
              {selectedMarket.outcomes.map((outcome) => (
                <div
                  key={outcome.name}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    borderTop: "1px solid rgba(125,211,252,0.14)",
                    padding: "7px 0",
                  }}
                >
                  <span>{outcome.name}</span>
                  <span style={{ color: "#94a3b8" }}>
                    {outcome.price ?? "n/a"}
                  </span>
                </div>
              ))}
              <div style={{ color: "#a7f3d0", margin: "18px 0 8px" }}>
                orderbook tokens
              </div>
              {selectedMarket.clobTokenIds.length ? (
                selectedMarket.clobTokenIds.map((tokenId) => (
                  <div key={tokenId} style={{ color: "#94a3b8" }}>
                    {tokenId}
                  </div>
                ))
              ) : (
                <div style={{ color: "#64748b" }}>no CLOB token ids</div>
              )}
            </>
          ) : (
            <div style={{ color: "#64748b" }}>no market selected</div>
          )}
          {state?.orders.reason && (
            <div style={{ color: "#fca5a5", marginTop: 18 }}>
              {state.orders.reason}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-polymarket-state") {
    const user = typeof params?.user === "string" ? params.user.trim() : "";
    const state = await loadPolymarketTuiState(user || undefined);
    return {
      viewType: "tui",
      status: state.status,
      markets: state.markets.markets.slice(
        0,
        typeof params?.limit === "number" ? params.limit : 25,
      ),
      orders: state.orders,
      positions: state.positions,
    };
  }

  if (capability === "terminal-polymarket-market") {
    const id = typeof params?.id === "string" ? params.id.trim() : "";
    const slug = typeof params?.slug === "string" ? params.slug.trim() : "";
    const polymarketClient = client as PolymarketClient;
    if (id) {
      return {
        viewType: "tui",
        ...(await polymarketClient.polymarketMarketById(id)),
      };
    }
    if (slug) {
      return {
        viewType: "tui",
        ...(await polymarketClient.polymarketMarketBySlug(slug)),
      };
    }
    throw new Error("id or slug is required");
  }

  if (capability === "terminal-polymarket-orderbook") {
    const tokenId =
      typeof params?.tokenId === "string" ? params.tokenId.trim() : "";
    if (!tokenId) throw new Error("tokenId is required");
    const orderbook: PolymarketOrderbookResponse = await (
      client as PolymarketClient
    ).polymarketOrderbook(tokenId);
    return { viewType: "tui", orderbook };
  }

  if (capability === "terminal-polymarket-positions") {
    const user = typeof params?.user === "string" ? params.user.trim() : "";
    if (!user) throw new Error("user is required");
    return {
      viewType: "tui",
      positions: await (client as PolymarketClient).polymarketPositions(user),
    };
  }

  if (capability === "terminal-polymarket-trading-check") {
    return {
      viewType: "tui",
      result: await postPolymarketCommand("/api/polymarket/orders", {
        marketId: typeof params?.marketId === "string" ? params.marketId : "",
        side: typeof params?.side === "string" ? params.side : "buy",
        outcome: typeof params?.outcome === "string" ? params.outcome : "",
        size:
          typeof params?.size === "number" || typeof params?.size === "string"
            ? params.size
            : 0,
      }),
    };
  }

  throw new Error(`Unsupported capability "${capability}"`);
}
