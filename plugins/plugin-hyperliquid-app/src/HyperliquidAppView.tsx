import type { OverlayAppContext } from "@elizaos/app-core";
import { Button, client, PagePanel, Spinner } from "@elizaos/app-core";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  ArrowLeft,
  BarChart3,
  CircleAlert,
  Cloud,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import "./client";
import type { HyperliquidClient } from "./client";
import type {
  HyperliquidMarketsResponse,
  HyperliquidOrdersResponse,
  HyperliquidPositionsResponse,
  HyperliquidStatusResponse,
} from "./hyperliquid-contracts";
import { useHyperliquidState } from "./useHyperliquidState";

function ReadinessPill({ ready, label }: { ready: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${
        ready
          ? "border-ok/35 bg-ok/12 text-ok"
          : "border-border bg-bg-accent text-muted"
      }`}
    >
      {ready ? (
        <ShieldCheck className="h-3.5 w-3.5" />
      ) : (
        <ShieldX className="h-3.5 w-3.5" />
      )}
      {label}
    </span>
  );
}

function credentialModeLabel(
  mode: "managed_vault" | "local_key" | "none" | undefined,
): string {
  switch (mode) {
    case "managed_vault":
      return "Managed vault";
    case "local_key":
      return "Local key";
    default:
      return "Read-only";
  }
}

async function loadHyperliquidTuiState(): Promise<{
  status: HyperliquidStatusResponse;
  markets: HyperliquidMarketsResponse | null;
  positions: HyperliquidPositionsResponse | null;
  orders: HyperliquidOrdersResponse | null;
}> {
  const hyperliquidClient = client as HyperliquidClient;
  const status = await hyperliquidClient.hyperliquidStatus();
  if (!status.publicReadReady) {
    return { status, markets: null, positions: null, orders: null };
  }
  const [markets, positions, orders] = await Promise.all([
    hyperliquidClient.hyperliquidMarkets(),
    hyperliquidClient.hyperliquidPositions(),
    hyperliquidClient.hyperliquidOrders(),
  ]);
  return { status, markets, positions, orders };
}

async function postHyperliquidCommand(
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
        : `Hyperliquid request failed with ${response.status}`;
    throw new Error(message);
  }
  return data;
}

export function HyperliquidAppView({ exitToApps }: OverlayAppContext) {
  const { status, markets, positions, orders, loading, error, refresh } =
    useHyperliquidState();

  const publicReadReady = status?.publicReadReady ?? false;
  const credentialMode = status?.credentialMode ?? "none";

  const backButton = useAgentElement<HTMLButtonElement>({
    id: "action-back",
    role: "button",
    label: "Back to apps",
    group: "hyperliquid-header",
    description: "Exit the Hyperliquid view and return to the apps overlay",
  });
  const refreshButton = useAgentElement<HTMLButtonElement>({
    id: "action-refresh",
    role: "button",
    label: "Refresh",
    group: "hyperliquid-header",
    description: "Reload Hyperliquid status, markets, positions, and orders",
    status: loading ? "active" : "inactive",
  });

  return (
    <div
      data-testid="hyperliquid-shell"
      className="fixed inset-0 z-50 flex h-[100vh] flex-col overflow-hidden bg-bg supports-[height:100dvh]:h-[100dvh]"
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border/20 bg-bg/80 px-4 py-3 backdrop-blur-sm">
        <Button
          ref={backButton.ref}
          {...backButton.agentProps}
          variant="ghost"
          size="icon"
          className="h-9 w-9 text-muted hover:text-txt"
          onClick={exitToApps}
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="min-w-0">
          <h1 className="text-base font-semibold text-txt">Hyperliquid</h1>
          <p className="truncate text-xs text-muted">
            Native read/status surface for Hyperliquid
          </p>
        </div>

        <div className="flex-1" />

        <Button
          ref={refreshButton.ref}
          {...refreshButton.agentProps}
          variant="ghost"
          size="icon"
          className="h-9 w-9 text-muted hover:text-txt"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="Refresh"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="chat-native-scrollbar flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <div className="mx-auto max-w-5xl space-y-4">
          {error && <PagePanel.Notice tone="danger">{error}</PagePanel.Notice>}

          <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-border/24 bg-card/50 px-4 py-3">
              <div className="text-xs font-semibold uppercase text-muted">
                Public reads
              </div>
              <div className="mt-3">
                <ReadinessPill
                  ready={publicReadReady}
                  label={publicReadReady ? "Ready" : "Unavailable"}
                />
              </div>
            </div>

            <div className="rounded-lg border border-border/24 bg-card/50 px-4 py-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase text-muted">
                {credentialMode === "managed_vault" ? (
                  <Cloud className="h-3.5 w-3.5" />
                ) : (
                  <KeyRound className="h-3.5 w-3.5" />
                )}
                Credentials
              </div>
              <div className="mt-3">
                <ReadinessPill
                  ready={status?.signerReady ?? false}
                  label={credentialModeLabel(credentialMode)}
                />
              </div>
            </div>

            <div className="rounded-lg border border-border/24 bg-card/50 px-4 py-3">
              <div className="text-xs font-semibold uppercase text-muted">
                Account
              </div>
              <div className="mt-3 truncate font-mono text-xs text-txt">
                {status?.account.address ?? "No account address configured"}
              </div>
            </div>
          </section>

          {status?.executionBlockedReason && (
            <div className="flex items-start gap-2 rounded-lg border border-border/24 bg-bg-accent px-4 py-3 text-sm text-muted">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{status.executionBlockedReason}</span>
            </div>
          )}

          {status && !status.vault.ready && credentialMode !== "local_key" && (
            <div className="rounded-lg border border-border/24 bg-bg-accent px-4 py-3 text-sm text-muted">
              {status.vault.guidance}
            </div>
          )}

          {loading && !markets ? (
            <div className="flex items-center justify-center py-16 text-sm text-muted">
              <Spinner className="mr-3 h-5 w-5" />
              Loading Hyperliquid state
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
              <section className="rounded-lg border border-border/24 bg-card/50">
                <div className="flex items-center gap-2 border-b border-border/20 px-4 py-3">
                  <BarChart3 className="h-4 w-4 text-muted" />
                  <h2 className="text-sm font-semibold text-txt">Markets</h2>
                  <span className="ml-auto text-xs text-muted">
                    {markets?.markets.length ?? 0}
                  </span>
                </div>
                <div className="divide-y divide-border/14">
                  {(markets?.markets ?? []).slice(0, 24).map((market) => (
                    <div
                      key={market.name}
                      className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-2.5 text-sm"
                    >
                      <span className="min-w-0 truncate font-medium text-txt">
                        {market.name}
                      </span>
                      <span className="text-xs text-muted">
                        {market.maxLeverage
                          ? `${market.maxLeverage}x`
                          : "No leverage data"}
                      </span>
                      <span className="font-mono text-xs text-muted">
                        sz {market.szDecimals}
                      </span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="space-y-4">
                <div className="rounded-lg border border-border/24 bg-card/50 px-4 py-3">
                  <h2 className="text-sm font-semibold text-txt">Positions</h2>
                  {positions?.readBlockedReason ? (
                    <p className="mt-2 text-xs text-muted">
                      {positions.readBlockedReason}
                    </p>
                  ) : (
                    <p className="mt-2 text-2xl font-semibold text-txt">
                      {positions?.positions.length ?? 0}
                    </p>
                  )}
                </div>

                <div className="rounded-lg border border-border/24 bg-card/50 px-4 py-3">
                  <h2 className="text-sm font-semibold text-txt">
                    Open orders
                  </h2>
                  {orders?.readBlockedReason ? (
                    <p className="mt-2 text-xs text-muted">
                      {orders.readBlockedReason}
                    </p>
                  ) : (
                    <p className="mt-2 text-2xl font-semibold text-txt">
                      {orders?.orders.length ?? 0}
                    </p>
                  )}
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function HyperliquidTuiView() {
  const [state, setState] = useState<Awaited<
    ReturnType<typeof loadHyperliquidTuiState>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastAction, setLastAction] = useState("boot");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadHyperliquidTuiState();
      setState(next);
      setLastAction("refresh");
    } catch (caught) {
      setState(null);
      setError(
        caught instanceof Error ? caught.message : "Hyperliquid refresh failed",
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
    viewId: "hyperliquid",
    publicReadReady: state?.status.publicReadReady ?? false,
    signerReady: state?.status.signerReady ?? false,
    executionReady: state?.status.executionReady ?? false,
    credentialMode: state?.status.credentialMode ?? "none",
    accountAddress: state?.status.account.address ?? null,
    marketCount: state?.markets?.markets.length ?? 0,
    positionCount: state?.positions?.positions.length ?? 0,
    orderCount: state?.orders?.orders.length ?? 0,
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
        elizaos://hyperliquid --type=tui
      </div>
      <div style={{ color: "#475569", marginBottom: 16 }}>
        {loading
          ? "loading"
          : state?.status.publicReadReady
            ? "read-ready"
            : "read-blocked"}{" "}
        | {state?.markets?.markets.length ?? 0} markets |{" "}
        {state?.positions?.positions.length ?? 0} positions |{" "}
        {state?.orders?.orders.length ?? 0} orders | {lastAction}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(300px, 1.2fr) minmax(280px, 0.8fr)",
          gap: 16,
        }}
      >
        <section
          aria-label="Hyperliquid markets"
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
            <strong style={{ color: "#e2e8f0" }}>markets</strong>
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
          {(state?.markets?.markets ?? []).slice(0, 24).map((market, index) => (
            <div
              key={market.name}
              style={{
                display: "grid",
                gridTemplateColumns: "4ch minmax(8ch, 1fr) 8ch",
                gap: 10,
                borderTop:
                  index === 0 ? "none" : "1px solid rgba(125,211,252,0.18)",
                padding: "8px 0",
              }}
            >
              <span style={{ color: "#64748b" }}>
                {String(index + 1).padStart(2, "0")}
              </span>
              <span
                style={{ color: market.isDelisted ? "#64748b" : "#e2e8f0" }}
              >
                {market.name}
              </span>
              <span style={{ color: "#a7f3d0" }}>
                {market.maxLeverage ? `${market.maxLeverage}x` : "n/a"}
              </span>
              <span style={{ gridColumn: "2 / 4", color: "#94a3b8" }}>
                sz {market.szDecimals}
                {market.onlyIsolated ? " / isolated-only" : ""}
                {market.isDelisted ? " / delisted" : ""}
              </span>
            </div>
          ))}
        </section>

        <section
          aria-label="Hyperliquid account"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
            borderRadius: 6,
            padding: 16,
            minHeight: 420,
          }}
        >
          <strong style={{ color: "#e2e8f0" }}>account</strong>
          <div style={{ color: "#64748b", margin: "6px 0 14px" }}>
            commands: state | market | execution-check
          </div>
          <div style={{ marginBottom: 12 }}>
            <div>
              <span style={{ color: "#64748b" }}>address</span>{" "}
              {state?.status.account.address ?? "not configured"}
            </div>
            <div>
              <span style={{ color: "#64748b" }}>credentials</span>{" "}
              {credentialModeLabel(state?.status.credentialMode)}
            </div>
            <div>
              <span style={{ color: "#64748b" }}>execution</span>{" "}
              {state?.status.executionReady ? "ready" : "disabled"}
            </div>
          </div>
          {state?.status.executionBlockedReason && (
            <div style={{ color: "#fca5a5", marginBottom: 12 }}>
              {state.status.executionBlockedReason}
            </div>
          )}
          {state?.positions?.readBlockedReason && (
            <div style={{ color: "#fca5a5", marginBottom: 12 }}>
              {state.positions.readBlockedReason}
            </div>
          )}
          <div style={{ color: "#a7f3d0", margin: "18px 0 8px" }}>
            positions
          </div>
          {(state?.positions?.positions ?? []).slice(0, 10).map((position) => (
            <div key={position.coin} style={{ padding: "4px 0" }}>
              {position.coin} size {position.size}
              {position.entryPx ? ` entry ${position.entryPx}` : ""}
              {position.unrealizedPnl ? ` uPnL ${position.unrealizedPnl}` : ""}
            </div>
          ))}
          <div style={{ color: "#a7f3d0", margin: "18px 0 8px" }}>orders</div>
          {(state?.orders?.orders ?? []).slice(0, 10).map((order) => (
            <div key={order.oid} style={{ padding: "4px 0" }}>
              {order.coin} {order.side} {order.size} @ {order.limitPx}
              {order.reduceOnly ? " reduce-only" : ""}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-hyperliquid-state") {
    const state = await loadHyperliquidTuiState();
    return {
      viewType: "tui",
      status: state.status,
      markets:
        state.markets?.markets.slice(
          0,
          typeof params?.limit === "number" ? params.limit : 25,
        ) ?? [],
      positions: state.positions,
      orders: state.orders,
    };
  }

  if (capability === "terminal-hyperliquid-market") {
    const coin =
      typeof params?.coin === "string" ? params.coin.trim().toUpperCase() : "";
    if (!coin) throw new Error("coin is required");
    const state = await loadHyperliquidTuiState();
    return {
      viewType: "tui",
      market:
        state.markets?.markets.find(
          (market) => market.name.toUpperCase() === coin,
        ) ?? null,
    };
  }

  if (capability === "terminal-hyperliquid-execution-check") {
    return {
      viewType: "tui",
      result: await postHyperliquidCommand("/api/hyperliquid/orders/open", {
        coin: typeof params?.coin === "string" ? params.coin : "BTC",
        side: typeof params?.side === "string" ? params.side : "buy",
        size: typeof params?.size === "string" ? params.size : "0",
      }),
    };
  }

  throw new Error(`Unsupported capability "${capability}"`);
}
