import type { OverlayAppContext } from "@elizaos/app-core";
import { Button, PagePanel, Spinner } from "@elizaos/app-core";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  ArrowLeft,
  BarChart3,
  CircleAlert,
  Cloud,
  KeyRound,
  type LucideIcon,
  Shield,
  ShieldX,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import "./client";
import { loadHyperliquidTuiState } from "./HyperliquidAppView.interact";
import { HyperliquidPositionsPanel } from "./HyperliquidPositionsPanel";
import type {
  HyperliquidCredentialMode,
  HyperliquidMarketsResponse,
  HyperliquidOrdersResponse,
  HyperliquidPositionsResponse,
  HyperliquidStatusResponse,
} from "./hyperliquid-contracts";
import { useHyperliquidState } from "./useHyperliquidState";

function BlockedPill({ label }: { label: string }) {
  return (
    <span
      className="inline-flex items-center text-muted"
      role="status"
      aria-label={label}
      title={label}
    >
      <ShieldX className="h-4 w-4" />
    </span>
  );
}

function StatusItem({
  icon: Icon,
  label,
  ready,
}: {
  icon: LucideIcon;
  label: string;
  ready: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className={`h-4 w-4 ${ready ? "text-ok" : "text-muted"}`} />
      <span className="truncate text-sm font-medium text-txt">{label}</span>
    </div>
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

export function HyperliquidAppView({ exitToApps }: OverlayAppContext) {
  const { status, markets, positions, orders, loading, error, unavailable } =
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
        </div>

        <div className="flex-1" />
      </div>

      <div className="chat-native-scrollbar flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <div className="mx-auto max-w-5xl space-y-5">
          {unavailable ? (
            <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
              <ShieldX className="h-8 w-8 text-muted" />
              <p className="text-sm font-medium text-txt">
                Hyperliquid is unavailable on this device
              </p>
              <p className="max-w-sm text-xs text-muted">
                Markets and account reads run on a desktop or cloud agent.
              </p>
            </div>
          ) : (
            <HyperliquidReady
              status={status}
              markets={markets}
              positions={positions}
              orders={orders}
              loading={loading}
              error={error}
              publicReadReady={publicReadReady}
              credentialMode={credentialMode}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function HyperliquidReady({
  status,
  markets,
  positions,
  orders,
  loading,
  error,
  publicReadReady,
  credentialMode,
}: {
  status: HyperliquidStatusResponse | null;
  markets: HyperliquidMarketsResponse | null;
  positions: HyperliquidPositionsResponse | null;
  orders: HyperliquidOrdersResponse | null;
  loading: boolean;
  error: string | null;
  publicReadReady: boolean;
  credentialMode: HyperliquidCredentialMode;
}) {
  return (
    <>
      {error && <PagePanel.Notice tone="danger">{error}</PagePanel.Notice>}

      <p className="text-sm text-muted">
        {publicReadReady ? "Read-only" : "Reads blocked"} ·{" "}
        {markets?.markets.length ?? 0} markets ·{" "}
        {status?.account.address ? "account connected" : "no account"}
      </p>

      <section className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <StatusItem icon={BarChart3} label="Reads" ready={publicReadReady} />
        <StatusItem
          icon={credentialMode === "managed_vault" ? Cloud : KeyRound}
          label={credentialModeLabel(credentialMode)}
          ready={status?.signerReady ?? false}
        />
        <StatusItem
          icon={Shield}
          label={status?.account.address ? "Account" : "No account"}
          ready={Boolean(status?.account.address)}
        />
      </section>

      {(status?.executionBlockedReason ||
        (status && !status.vault.ready && credentialMode !== "local_key")) && (
        <div className="flex items-start gap-2 text-sm text-muted">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            {status?.executionBlockedReason && (
              <span className="block">{status.executionBlockedReason}</span>
            )}
            {status &&
              !status.vault.ready &&
              credentialMode !== "local_key" && (
                <span className="block">{status.vault.guidance}</span>
              )}
          </div>
        </div>
      )}

      {loading && !markets ? (
        <div className="flex items-center justify-center py-16 text-sm text-muted">
          <Spinner className="mr-3 h-5 w-5" />
          Loading Hyperliquid state
        </div>
      ) : (
        <div className="space-y-4">
          <section className="rounded-lg border border-border/24">
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
                    {market.maxLeverage ? `${market.maxLeverage}x` : "—"}
                  </span>
                  <span className="font-mono text-xs text-muted">
                    sz {market.szDecimals}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="divide-y divide-border/14">
            <HyperliquidPositionsPanel
              positions={positions?.positions ?? []}
              summary={positions?.summary ?? null}
              readBlockedReason={positions?.readBlockedReason ?? null}
            />

            <div className="flex items-center justify-between gap-3 py-3">
              <h2 className="text-sm font-semibold text-txt">Orders</h2>
              {orders?.readBlockedReason ? (
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-xs text-muted">
                    {orders.readBlockedReason}
                  </span>
                  <BlockedPill label="Blocked" />
                </div>
              ) : (
                <span className="text-sm font-semibold text-txt">
                  {orders?.orders.length ?? 0}
                </span>
              )}
            </div>
          </section>
        </div>
      )}
    </>
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

  const tuiRefreshButton = useAgentElement<HTMLButtonElement>({
    id: "tui-refresh",
    role: "button",
    label: "Refresh",
    group: "hyperliquid-tui-markets",
    description:
      "Reload Hyperliquid status, markets, positions, and orders in the terminal view",
    status: loading ? "active" : "inactive",
  });

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
          gridTemplateColumns: "1fr",
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
              ref={tuiRefreshButton.ref}
              {...tuiRefreshButton.agentProps}
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
            {state?.positions?.positions.length ?? 0} positions /{" "}
            {state?.orders?.orders.length ?? 0} orders
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
