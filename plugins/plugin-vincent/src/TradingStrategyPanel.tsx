/**
 * TradingStrategyPanel — displays Vincent strategy configuration.
 */

import { Button, StatusBadge } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  Activity,
  ExternalLink,
  Gauge,
  Repeat2,
  Settings2,
} from "lucide-react";
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

  const openVincent = useAgentElement<HTMLAnchorElement>({
    id: "link-open-vincent",
    role: "link",
    label: "Open Vincent",
    group: "vincent-strategy",
    description: "Open the Vincent dashboard at heyvincent.ai in a new tab",
  });

  return (
    <div className="space-y-3 rounded-2xl border border-border/18 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_98%,transparent))] px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold text-txt">Strategy</span>
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
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-xl border border-border/20 bg-card/45 px-3 py-3 text-center">
            <Settings2 className="mx-auto h-4 w-4 text-muted" />
            <div className="mt-2 text-xs font-semibold text-muted">Unset</div>
          </div>
          <div className="rounded-xl border border-border/20 bg-card/45 px-3 py-3 text-center">
            <Gauge className="mx-auto h-4 w-4 text-muted" />
            <div className="mt-2 text-xs font-semibold text-muted">0%</div>
          </div>
          <div className="rounded-xl border border-border/20 bg-card/45 px-3 py-3 text-center">
            <Repeat2 className="mx-auto h-4 w-4 text-muted" />
            <div className="mt-2 text-xs font-semibold text-muted">Idle</div>
          </div>
        </div>
      )}

      {strategy !== null && (
        <>
          <div className="grid gap-2 sm:grid-cols-4">
            <div className="rounded-xl border border-accent/20 bg-accent/10 px-3 py-3">
              <Settings2 className="h-4 w-4 text-accent" />
              <div className="mt-2 truncate text-xs font-semibold text-txt">
                {strategy.venues.join(" + ") || "Venue"}
              </div>
            </div>
            <div className="rounded-xl border border-border/20 bg-card/45 px-3 py-3">
              <Repeat2 className="h-4 w-4 text-muted" />
              <div className="mt-2 text-xs font-semibold tabular-nums text-txt">
                {strategy.intervalSeconds}s
              </div>
            </div>
            <div
              className={`rounded-xl border px-3 py-3 ${
                strategy.dryRun
                  ? "border-warn/30 bg-warn/10 text-warn"
                  : "border-ok/25 bg-ok/10 text-ok"
              }`}
            >
              <Gauge className="h-4 w-4" />
              <div className="mt-2 text-xs font-semibold">
                {strategy.dryRun ? "Dry" : "Live"}
              </div>
            </div>
            <div className="rounded-xl border border-border/20 bg-card/45 px-3 py-3">
              <Activity className="h-4 w-4 text-muted" />
              <div className="mt-2 text-xs font-semibold tabular-nums text-txt">
                {paramEntries.length}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {paramEntries.slice(0, 6).map(([key, val]) => (
              <span
                key={key}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/25 bg-card/55 px-3 py-1.5 text-xs font-semibold text-muted"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-accent/70" />
                <span className="truncate">{key}</span>
                <span className="max-w-24 truncate font-mono text-txt">
                  {String(val)}
                </span>
              </span>
            ))}
            {paramEntries.length > 6 ? (
              <span className="inline-flex items-center rounded-full border border-border/25 bg-card/55 px-3 py-1.5 text-xs font-semibold text-muted">
                +{paramEntries.length - 6}
              </span>
            ) : null}
          </div>

          <Button
            asChild
            variant="outline"
            size="sm"
            className="h-9 w-fit rounded-xl px-4 text-xs font-semibold"
          >
            <a
              ref={openVincent.ref}
              {...openVincent.agentProps}
              href="https://heyvincent.ai"
              target="_blank"
              rel="noreferrer"
            >
              Open Vincent
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        </>
      )}
    </div>
  );
}
