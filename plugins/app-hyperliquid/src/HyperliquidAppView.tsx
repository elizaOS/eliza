import type { OverlayAppContext } from "@elizaos/app-core";
import { Button, PagePanel, Spinner } from "@elizaos/app-core";
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

export function HyperliquidAppView({ exitToApps }: OverlayAppContext) {
  const { status, markets, positions, orders, loading, error, refresh } =
    useHyperliquidState();

  const publicReadReady = status?.publicReadReady ?? false;
  const credentialMode = status?.credentialMode ?? "none";

  return (
    <div
      data-testid="hyperliquid-shell"
      className="fixed inset-0 z-50 flex h-[100vh] flex-col overflow-hidden bg-bg supports-[height:100dvh]:h-[100dvh]"
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border/20 bg-bg/80 px-4 py-3 backdrop-blur-sm">
        <Button
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
