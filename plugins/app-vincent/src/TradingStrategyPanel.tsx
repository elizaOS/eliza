/**
 * TradingStrategyPanel — displays Vincent strategy configuration.
 */

import { Button, StatusBadge } from "@elizaos/ui";
import { Activity, ExternalLink, Settings2 } from "lucide-react";
import type { VincentStrategy } from "./vincent-contracts";

interface TradingStrategyPanelProps {
  strategy: VincentStrategy | null;
}

const STRATEGY_LABELS: Record<VincentStrategy["name"], string> = {
  dca: "DCA",
  rebalance: "Rebalance",
  threshold: "Threshold",
  manual: "Manual",
};

export function TradingStrategyPanel({ strategy }: TradingStrategyPanelProps) {
  const strategyName = strategy?.name ?? null;
  const params = strategy?.params ?? {};
  const paramEntries = Object.entries(params);

  return (
    <div className="space-y-4 rounded-3xl border border-border/18 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_98%,transparent))] px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold text-txt">
            Vincent Trading Agent
          </span>
        </div>
        <div className="flex items-center gap-2">
          {strategyName && (
            <StatusBadge label={STRATEGY_LABELS[strategyName]} tone="muted" />
          )}
          {strategy !== null && (
            <StatusBadge label="Configured" tone="success" withDot />
          )}
        </div>
      </div>

      {strategy === null && (
        <p className="text-xs leading-relaxed text-muted">
          No Vincent trading strategy is configured in Eliza yet. Vincent
          handles Hyperliquid and Polymarket execution after OAuth connection;
          Eliza does not run a local trading loop.
        </p>
      )}

      {strategy !== null && (
        <>
          <div className="overflow-hidden rounded-xl border border-border/20 bg-card/40">
            <div className="flex items-center gap-1.5 border-b border-border/20 px-4 py-2">
              <Settings2 className="h-3 w-3 text-muted" />
              <span className="text-xs-tight font-semibold uppercase tracking-wider text-muted/70">
                Configuration
              </span>
            </div>
            <div className="divide-y divide-border/10">
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="text-xs text-muted">Venues</span>
                <span className="font-mono text-xs text-txt">
                  {strategy.venues.join(", ")}
                </span>
              </div>
              {paramEntries.map(([key, val]) => (
                <div
                  key={key}
                  className="flex items-center justify-between px-4 py-2.5"
                >
                  <span className="text-xs text-muted">{key}</span>
                  <span className="font-mono text-xs text-txt">
                    {String(val)}
                  </span>
                </div>
              ))}
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="text-xs text-muted">Interval</span>
                <span className="font-mono text-xs text-txt">
                  {strategy.intervalSeconds}s
                </span>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="text-xs text-muted">Dry run</span>
                <span
                  className={`font-mono text-xs ${strategy.dryRun ? "text-warn" : "text-txt"}`}
                >
                  {strategy.dryRun ? "Yes" : "No"}
                </span>
              </div>
            </div>
          </div>

          <Button
            asChild
            variant="outline"
            size="sm"
            className="h-9 w-fit rounded-xl px-4 text-xs font-semibold"
          >
            <a href="https://heyvincent.ai" target="_blank" rel="noreferrer">
              Open Vincent
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        </>
      )}
    </div>
  );
}
