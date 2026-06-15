/**
 * VincentAppView — full-screen overlay app for Vincent trading access.
 *
 * Layout:
 *   - Header with back button and connection status badge
 *   - VincentConnectionCard (OAuth connect/disconnect)
 *   - WalletStatusCard (agent wallet addresses + balances) — when connected
 *   - TradingStrategyPanel (strategy config) — when connected
 *   - TradingProfileCard (P&L analytics) — when connected
 *
 * Implements the OverlayApp Component contract.
 */

import type { WalletAddresses } from "@elizaos/shared";
import type { OverlayAppContext } from "@elizaos/ui";
import { Button, PagePanel, Spinner, useApp } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  ArrowLeft,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { TradingProfileCard } from "./TradingProfileCard";
import { TradingStrategyPanel } from "./TradingStrategyPanel";
import { useVincentDashboard } from "./useVincentDashboard";
import { loadVincentTuiState } from "./VincentAppView.helpers";
import { VincentConnectionCard } from "./VincentConnectionCard";
import { WalletStatusCard } from "./WalletStatusCard";

export function VincentAppView({ exitToApps, t }: OverlayAppContext) {
  const { setActionNotice } = useApp();

  const backLabel = t("nav.back", { defaultValue: "Back" });
  const refreshLabel = t("actions.refresh", { defaultValue: "Refresh" });
  const back = useAgentElement<HTMLButtonElement>({
    id: "action-back",
    role: "button",
    label: backLabel,
    group: "vincent-header",
    description: "Exit the Vincent app and return to the apps grid",
  });
  const refreshControl = useAgentElement<HTMLButtonElement>({
    id: "action-refresh",
    role: "button",
    label: refreshLabel,
    group: "vincent-header",
    description: "Reload Vincent connection status, wallet, strategy and P&L",
  });

  const {
    vincentConnected,
    walletAddresses,
    walletBalances,
    strategy,
    tradingProfile,
    loading,
    error,
    refresh,
  } = useVincentDashboard();

  return (
    <div
      data-testid="vincent-shell"
      className="fixed inset-0 z-50 flex h-[100vh] flex-col overflow-hidden bg-bg pb-[var(--safe-area-bottom,0px)] pl-[var(--safe-area-left,0px)] pr-[var(--safe-area-right,0px)] pt-[var(--safe-area-top,0px)] supports-[height:100dvh]:h-[100dvh]"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/20 bg-bg/80 px-4 py-3 backdrop-blur-sm">
        <div className="flex min-w-0 flex-1 items-center gap-3">
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
            <h1 className="text-base font-semibold text-txt">Vincent</h1>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Connection status pill */}
          <span
            data-testid="vincent-status-card"
            className={`inline-flex max-w-[8.5rem] items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs-tight font-semibold ${
              vincentConnected
                ? "border-ok/35 bg-ok/12 text-ok"
                : "border-border bg-bg-accent text-muted"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${vincentConnected ? "bg-ok" : "bg-muted"}`}
            />
            <span className="truncate">
              {vincentConnected
                ? t("vincent.statusConnected", { defaultValue: "Connected" })
                : t("vincent.statusDisconnected", {
                    defaultValue: "Disconnected",
                  })}
            </span>
          </span>

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
      </div>

      {/* Scrollable content */}
      <div className="chat-native-scrollbar flex-1 overflow-y-auto px-4 pb-32 pt-4 sm:px-6 sm:pb-36">
        <div className="mx-auto max-w-5xl">
          {/* Error banner */}
          {error && <PagePanel.Notice tone="danger">{error}</PagePanel.Notice>}

          {/* Initial loading state */}
          {loading && !vincentConnected && walletAddresses === null && (
            <div className="flex items-center justify-center py-16">
              <Spinner className="h-5 w-5 text-muted" />
              <span className="ml-3 text-sm text-muted">Loading…</span>
            </div>
          )}

          <div className="flex flex-col gap-4">
            <div className="space-y-4">
              <VincentConnectionCard setActionNotice={setActionNotice} t={t} />

              {vincentConnected && (
                <>
                  <WalletStatusCard
                    walletAddresses={walletAddresses}
                    walletBalances={walletBalances}
                    setActionNotice={setActionNotice}
                  />

                  <TradingStrategyPanel strategy={strategy} />

                  <TradingProfileCard tradingProfile={tradingProfile} />
                </>
              )}

              {!vincentConnected && !loading && (
                <div className="grid gap-3 rounded-lg border border-border/18 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_98%,transparent))] px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] sm:grid-cols-3">
                  <div className="flex items-center gap-3 rounded-xl border border-accent/20 bg-accent/10 px-3 py-3">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-accent/25 bg-accent/12 text-accent">
                      <ShieldCheck className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 text-sm font-semibold text-txt">
                      Vincent
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-xl border border-border/20 bg-card/45 px-3 py-3">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border/25 bg-bg/50 text-muted">
                      <Wallet className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 text-sm font-semibold text-txt">
                      Wallet
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-xl border border-border/20 bg-card/45 px-3 py-3">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border/25 bg-bg/50 text-muted">
                      <KeyRound className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 text-sm font-semibold text-txt">
                      OAuth
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function VincentTuiView() {
  const [state, setState] = useState<Awaited<
    ReturnType<typeof loadVincentTuiState>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastAction, setLastAction] = useState("boot");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadVincentTuiState();
      setState(next);
      setLastAction("refresh");
    } catch (caught) {
      setState(null);
      setError(
        caught instanceof Error ? caught.message : "Vincent refresh failed",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const tuiRefresh = useAgentElement<HTMLButtonElement>({
    id: "tui-action-refresh",
    role: "button",
    label: "Refresh",
    group: "vincent-tui-access",
    description: "Reload Vincent connection, wallet, strategy and P&L state",
  });

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const strategy = state?.strategy.strategy ?? null;
  const profile = state?.tradingProfile.profile ?? null;
  const walletAddresses = state?.walletAddresses as
    | (WalletAddresses & Record<string, unknown>)
    | null
    | undefined;
  const viewState = {
    viewType: "tui",
    viewId: "vincent",
    connected: state?.status.connected ?? false,
    connectedAt: state?.status.connectedAt ?? null,
    venues: state?.status.tradingVenues ?? [],
    evmAddress:
      typeof walletAddresses?.evm === "string" ? walletAddresses.evm : null,
    solanaAddress:
      typeof walletAddresses?.solana === "string"
        ? walletAddresses.solana
        : null,
    strategyName: strategy?.name ?? null,
    strategyRunning: strategy?.running ?? false,
    dryRun: strategy?.dryRun ?? null,
    totalPnl: profile?.totalPnl ?? null,
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
        elizaos://vincent --type=tui
      </div>
      <div style={{ color: "#475569", marginBottom: 16 }}>
        {loading
          ? "loading"
          : state?.status.connected
            ? "connected"
            : "disconnected"}{" "}
        | {(state?.status.tradingVenues ?? []).join(",") || "no venues"} |{" "}
        {lastAction}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: 16,
        }}
      >
        <section
          aria-label="Vincent access"
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
            <strong style={{ color: "#e2e8f0" }}>access</strong>
            <button
              ref={tuiRefresh.ref}
              {...tuiRefresh.agentProps}
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
          <div>
            <span style={{ color: "#64748b" }}>connected</span>{" "}
            {state?.status.connected ? "yes" : "no"}
          </div>
          <div>
            <span style={{ color: "#64748b" }}>connectedAt</span>{" "}
            {state?.status.connectedAt ?? "n/a"}
          </div>
          <div>
            <span style={{ color: "#64748b" }}>venues</span>{" "}
            {(state?.status.tradingVenues ?? []).join(", ") || "n/a"}
          </div>
          <div style={{ color: "#a7f3d0", margin: "18px 0 8px" }}>wallet</div>
          <div>evm {viewState.evmAddress ?? "n/a"}</div>
          <div>solana {viewState.solanaAddress ?? "n/a"}</div>
          {!state?.status.connected && !loading ? (
            <div style={{ color: "#94a3b8", marginTop: 18 }}>
              Use terminal-vincent-start-login to begin OAuth.
            </div>
          ) : null}
        </section>

        <section
          aria-label="Vincent trading"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
            borderRadius: 6,
            padding: 16,
            minHeight: 420,
          }}
        >
          <strong style={{ color: "#e2e8f0" }}>strategy</strong>
          <div style={{ color: "#64748b", margin: "6px 0 14px" }}>
            {strategy?.running ? "running" : "idle"} /{" "}
            {strategy?.dryRun ? "dry-run" : "live"}
          </div>
          <div>
            <span style={{ color: "#64748b" }}>name</span>{" "}
            {strategy?.name ?? "not configured"}
          </div>
          <div>
            <span style={{ color: "#64748b" }}>interval</span>{" "}
            {strategy?.intervalSeconds ?? "n/a"}
          </div>
          <div>
            <span style={{ color: "#64748b" }}>dryRun</span>{" "}
            {typeof strategy?.dryRun === "boolean"
              ? String(strategy.dryRun)
              : "n/a"}
          </div>
          <div>
            <span style={{ color: "#64748b" }}>running</span>{" "}
            {typeof strategy?.running === "boolean"
              ? String(strategy.running)
              : "n/a"}
          </div>
          <div style={{ color: "#a7f3d0", margin: "18px 0 8px" }}>profile</div>
          <div>pnl {profile?.totalPnl ?? "n/a"}</div>
          <div>winRate {profile?.winRate ?? "n/a"}</div>
          <div>swaps {profile?.totalSwaps ?? "n/a"}</div>
          {(profile?.tokenBreakdown ?? []).map((token) => (
            <div
              key={token.symbol}
              style={{ color: "#94a3b8", padding: "4px 0" }}
            >
              {token.symbol} pnl {token.pnl} swaps {token.swaps}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
