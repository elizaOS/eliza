import type { OverlayAppContext } from "@elizaos/app-core";
import { Button, PagePanel, Spinner } from "@elizaos/app-core";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  ArrowLeft,
  CheckCircle2,
  LockKeyhole,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { loadPolymarketTuiState } from "./PolymarketAppView.helpers";
import type { PolymarketMarket } from "./polymarket-contracts";
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

  const selectedMarketId = selectedMarket?.id;

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
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {error && <PagePanel.Notice tone="danger">{error}</PagePanel.Notice>}

          {selectedMarket ? (
            <section className="min-w-0 rounded-lg border border-border/20 bg-bg-accent/60 p-5">
              <button
                type="button"
                onClick={() => setSelectedMarket(null)}
                className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-txt"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to markets
              </button>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="mt-2 text-xl font-semibold leading-tight text-txt">
                    {selectedMarket.question ?? selectedMarket.slug}
                  </h2>
                </div>
                <StatusPill ready={selectedMarket.active === true} />
              </div>

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
            </section>
          ) : (
            <section className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <StatusTile
                  label="Reads"
                  ready={status?.publicReads.ready ?? false}
                />
                <StatusTile
                  label="Trading"
                  ready={status?.trading.ready ?? false}
                />
              </div>

              {status?.trading.missing.length ? (
                <div className="flex items-center gap-2 rounded-md border border-warn/25 bg-warn/10 p-3 text-xs text-muted">
                  <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-warn" />
                  <span className="truncate">{status.trading.reason}</span>
                </div>
              ) : null}

              <div className="overflow-hidden rounded-lg border border-border/20 bg-bg-accent/60">
                <div className="flex items-center justify-between border-b border-border/20 px-4 py-3">
                  <h2 className="text-sm font-semibold text-txt">Markets</h2>
                  <span className="text-xs font-semibold tabular-nums text-muted">
                    {markets.length}
                  </span>
                </div>
                {loading && markets.length === 0 ? (
                  <div className="flex items-center justify-center gap-3 p-4 text-sm text-muted">
                    <Spinner className="h-4 w-4" />
                  </div>
                ) : (
                  <div className="divide-y divide-border/15">
                    {markets.map((market) => (
                      <MarketListItem
                        key={market.id}
                        market={market}
                        active={selectedMarketId === market.id}
                        onSelect={setSelectedMarket}
                      />
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}
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
      <span className="mt-1 block truncate text-xs text-muted">
        {market.volume24hr ?? market.category ?? market.id}
      </span>
    </button>
  );
}

function PolymarketTuiMarketRow({
  market,
  index,
  active,
  onSelect,
}: {
  market: PolymarketMarket;
  index: number;
  active: boolean;
  onSelect: (market: PolymarketMarket) => void;
}) {
  const label = market.question ?? market.slug ?? market.id;
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `tui-market-${market.id}`,
    role: "list-item",
    label,
    group: "polymarket-tui-markets",
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
      style={{
        display: "grid",
        gridTemplateColumns: "4ch minmax(0,1fr) 10ch",
        gap: 10,
        width: "100%",
        border: "none",
        borderTop: index === 0 ? "none" : "1px solid rgba(125,211,252,0.18)",
        background: active ? "rgba(125,211,252,0.08)" : "transparent",
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
      <span style={{ color: "#e2e8f0", overflow: "hidden" }}>{label}</span>
      <span style={{ color: market.active ? "#a7f3d0" : "#94a3b8" }}>
        {market.active ? "active" : "closed"}
      </span>
      <span style={{ gridColumn: "2 / 4", color: "#94a3b8" }}>
        vol {market.volume ?? "n/a"} / liq {market.liquidity ?? "n/a"}
      </span>
    </button>
  );
}

function StatusPill({ ready }: { ready: boolean }) {
  return (
    <span
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
        ready
          ? "border-ok/35 bg-ok/12 text-ok"
          : "border-border bg-bg text-muted"
      }`}
      role="status"
      aria-label={ready ? "Ready" : "Disabled"}
      title={ready ? "Ready" : "Disabled"}
    >
      {ready ? (
        <CheckCircle2 className="h-4 w-4" />
      ) : (
        <XCircle className="h-4 w-4" />
      )}
    </span>
  );
}

function StatusTile({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div
      className="flex min-h-16 items-center justify-center gap-2 rounded-lg border border-border/20 bg-bg-accent/60 px-3"
      title={label}
    >
      {ready ? (
        <CheckCircle2 className="h-4 w-4 text-ok" />
      ) : (
        <XCircle className="h-4 w-4 text-muted" />
      )}
      <span className="text-sm font-semibold text-txt">{label}</span>
    </div>
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

  const refreshControl = useAgentElement<HTMLButtonElement>({
    id: "tui-action-refresh",
    role: "button",
    label: "Refresh",
    group: "polymarket-tui-markets",
    description: "Reload Polymarket status and active markets",
    onActivate: () => void refresh(),
  });

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
              ref={refreshControl.ref}
              {...refreshControl.agentProps}
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
            <PolymarketTuiMarketRow
              key={market.id}
              market={market}
              index={index}
              active={selectedMarket?.id === market.id}
              onSelect={setSelectedMarket}
            />
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
