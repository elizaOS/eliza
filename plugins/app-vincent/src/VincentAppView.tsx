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

import type { OverlayAppContext } from "@elizaos/ui";
import { Button, PagePanel, Spinner, useApp } from "@elizaos/ui";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { TradingProfileCard } from "./TradingProfileCard";
import { TradingStrategyPanel } from "./TradingStrategyPanel";
import { useVincentDashboard } from "./useVincentDashboard";
import { VincentConnectionCard } from "./VincentConnectionCard";
import { WalletStatusCard } from "./WalletStatusCard";

export function VincentAppView({ exitToApps, t }: OverlayAppContext) {
  const { setActionNotice } = useApp();

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
      className="fixed inset-0 z-50 flex flex-col bg-bg h-[100vh] overflow-hidden supports-[height:100dvh]:h-[100dvh]"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/20 bg-bg/80 px-4 py-3 backdrop-blur-sm">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 rounded-xl text-muted hover:text-txt"
            onClick={exitToApps}
            aria-label={t("nav.back", { defaultValue: "Back" })}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-txt">Vincent</h1>
            <p className="truncate text-xs-tight text-muted leading-tight">
              Hyperliquid and Polymarket trading access
            </p>
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
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-xl text-muted hover:text-txt"
            onClick={refresh}
            disabled={loading}
            aria-label={t("actions.refresh", { defaultValue: "Refresh" })}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="chat-native-scrollbar flex-1 overflow-y-auto px-4 py-4 sm:px-6">
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

          {/* Two-column grid: main cards left, wallet summary top-right */}
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_minmax(280px,340px)] gap-4 items-start">
            {/* Left column — main cards */}
            <div className="space-y-4">
              <VincentConnectionCard setActionNotice={setActionNotice} t={t} />

              {vincentConnected && (
                <>
                  <TradingStrategyPanel strategy={strategy} />

                  <TradingProfileCard tradingProfile={tradingProfile} />
                </>
              )}

              {/* Not-connected informational card */}
              {!vincentConnected && !loading && (
                <div className="rounded-3xl border border-border/18 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_98%,transparent))] px-5 py-8 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                  <p className="text-sm font-medium text-txt">
                    {t("vincent.connectPrompt", {
                      defaultValue:
                        "Connect your Vincent account to get started",
                    })}
                  </p>
                  <p className="mx-auto mt-2 max-w-sm text-xs text-muted leading-relaxed">
                    {t("vincent.connectPromptDetail", {
                      defaultValue:
                        "Once connected, you'll see wallet context, Vincent strategy status, and trading analytics when Vincent exposes them.",
                    })}
                  </p>
                </div>
              )}
            </div>

            {/* Right column — wallet status (top-right, sticky on desktop) */}
            {vincentConnected && (
              <div
                data-testid="vincent-wallet-status-area"
                className="lg:sticky lg:top-4"
              >
                <WalletStatusCard
                  walletAddresses={walletAddresses}
                  walletBalances={walletBalances}
                  setActionNotice={setActionNotice}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
