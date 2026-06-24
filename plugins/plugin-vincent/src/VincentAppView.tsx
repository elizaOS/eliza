/** VincentAppView — full-screen overlay app for Vincent trading access. */

import type { OverlayAppContext } from "@elizaos/ui";
import { Button, PagePanel, Spinner, useAppSelector } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  ArrowLeft,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { TradingProfileCard } from "./TradingProfileCard";
import { TradingStrategyPanel } from "./TradingStrategyPanel";
import { useVincentDashboard } from "./useVincentDashboard";
import { VincentConnectionCard } from "./VincentConnectionCard";
import { WalletStatusCard } from "./WalletStatusCard";

export function VincentAppView({ exitToApps, t }: OverlayAppContext) {
  // Subscribe to only the stable `setActionNotice` callback instead of the whole
  // AppContext value, which is rebuilt on a large dependency array — this stops
  // VincentAppView (and its card subtree) re-rendering on unrelated context churn.
  const setActionNotice = useAppSelector((s) => s.setActionNotice);

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
      <div className="flex shrink-0 items-center justify-between gap-3 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Button
            ref={back.ref}
            {...back.agentProps}
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 text-muted hover:text-txt"
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
            className={`inline-flex max-w-[8.5rem] items-center gap-1.5 px-1 py-1 text-xs-tight font-semibold ${
              vincentConnected ? "text-ok" : "text-muted"
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
            className="h-9 w-9 text-muted hover:text-txt"
            onClick={refresh}
            disabled={loading}
            aria-label={refreshLabel}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="chat-native-scrollbar flex-1 overflow-y-auto px-3 pb-32 pt-2 sm:px-5 sm:pb-36">
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
            <div className="space-y-3">
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
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-1 py-2 text-sm font-semibold text-muted">
                  <span className="flex items-center gap-2 text-accent">
                    <ShieldCheck className="h-4 w-4" />
                    Vincent
                  </span>
                  <span className="flex items-center gap-2">
                    <Wallet className="h-4 w-4" />
                    Wallet
                  </span>
                  <span className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4" />
                    OAuth
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
