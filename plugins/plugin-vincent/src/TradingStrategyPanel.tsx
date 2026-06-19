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
    <div className="space-y-3 rounded-2xl border border-border/18 px-4 py-4">
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
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-1 text-xs font-semibold text-muted">
          <span className="flex items-center gap-2">
            <Settings2 className="h-4 w-4" />
            Unset
          </span>
          <span className="flex items-center gap-2">
            <Gauge className="h-4 w-4" />
            0%
          </span>
          <span className="flex items-center gap-2">
            <Repeat2 className="h-4 w-4" />
            Idle
          </span>
        </div>
      )}

      {strategy !== null && (
        <>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-1 text-xs font-semibold">
            <span className="flex items-center gap-2 text-accent">
              <Settings2 className="h-4 w-4" />
              <span className="truncate text-txt">
                {strategy.venues.join(" + ") || "Venue"}
              </span>
            </span>
            <span className="flex items-center gap-2 text-muted">
              <Repeat2 className="h-4 w-4" />
              <span className="tabular-nums text-txt">
                {strategy.intervalSeconds}s
              </span>
            </span>
            <span
              className={`flex items-center gap-2 ${strategy.dryRun ? "text-warn" : "text-ok"}`}
            >
              <Gauge className="h-4 w-4" />
              {strategy.dryRun ? "Dry" : "Live"}
            </span>
            <span className="flex items-center gap-2 text-muted">
              <Activity className="h-4 w-4" />
              <span className="tabular-nums text-txt">
                {paramEntries.length}
              </span>
            </span>
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
