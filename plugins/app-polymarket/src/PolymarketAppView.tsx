import type { OverlayAppContext } from "@elizaos/app-core";
import { Button, PagePanel, Spinner } from "@elizaos/app-core";
import { ArrowLeft, LockKeyhole, RefreshCw } from "lucide-react";
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

  return (
    <div
      data-testid="polymarket-shell"
      className="fixed inset-0 z-50 flex h-[100vh] flex-col overflow-hidden bg-bg supports-[height:100dvh]:h-[100dvh]"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border/20 bg-bg/80 px-4 py-3 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3">
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
            <h1 className="truncate text-base font-semibold text-txt">
              Polymarket
            </h1>
            <p className="truncate text-xs-tight text-muted">
              Native market discovery and trading readiness
            </p>
          </div>
        </div>

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
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    Gamma and Data API reads are public.
                  </p>
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
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    Orders stay disabled until signed CLOB calls are
                    implemented.
                  </p>
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
                    <button
                      key={market.id}
                      type="button"
                      onClick={() => setSelectedMarket(market)}
                      className={`block w-full px-4 py-3 text-left hover:bg-bg ${
                        selectedMarket?.id === market.id ? "bg-bg" : ""
                      }`}
                    >
                      <span className="line-clamp-2 text-sm font-medium text-txt">
                        {market.question ?? market.slug ?? market.id}
                      </span>
                      <span className="mt-1 block text-xs text-muted">
                        {market.volume24hr
                          ? `24h volume ${market.volume24hr}`
                          : (market.category ?? "Market")}
                      </span>
                    </button>
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

function StatusPill({ ready }: { ready: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs-tight font-semibold ${
        ready
          ? "border-ok/35 bg-ok/12 text-ok"
          : "border-border bg-bg text-muted"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${ready ? "bg-ok" : "bg-muted"}`}
      />
      {ready ? "Ready" : "Disabled"}
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
