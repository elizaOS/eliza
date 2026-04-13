/**
 * TradingStrategyPanel — displays the active trading strategy and controls.
 *
 * Shows strategy name badge, parameter table, dry-run toggle, and
 * Start/Stop buttons that POST to /api/vincent/trading/start|stop.
 */

import { Button, StatusBadge } from "@elizaos/app-core";
import { Activity, Pause, Play, RefreshCw, Settings2 } from "lucide-react";
import { useCallback, useState } from "react";
import type { VincentStrategy } from "./useVincentDashboard";

interface TradingStrategyPanelProps {
  strategy: VincentStrategy | null;
  onStrategyChange?: () => void;
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
  ) => void;
}

const STRATEGY_LABELS: Record<NonNullable<VincentStrategy["name"]>, string> = {
  dca: "DCA",
  rebalance: "Rebalance",
  threshold: "Threshold",
  manual: "Manual",
};

async function postStrategyControl(
  path: "/api/vincent/trading/start" | "/api/vincent/trading/stop",
): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

export function TradingStrategyPanel({
  strategy,
  onStrategyChange,
  setActionNotice,
}: TradingStrategyPanelProps) {
  const [actionInFlight, setActionInFlight] = useState<"start" | "stop" | null>(
    null,
  );

  const handleStart = useCallback(async () => {
    setActionInFlight("start");
    try {
      await postStrategyControl("/api/vincent/trading/start");
      setActionNotice("Trading started", "success", 3000);
      onStrategyChange?.();
    } catch (err) {
      setActionNotice(
        err instanceof Error ? err.message : "Failed to start trading",
        "error",
        4000,
      );
    } finally {
      setActionInFlight(null);
    }
  }, [setActionNotice, onStrategyChange]);

  const handleStop = useCallback(async () => {
    setActionInFlight("stop");
    try {
      await postStrategyControl("/api/vincent/trading/stop");
      setActionNotice("Trading stopped", "info", 3000);
      onStrategyChange?.();
    } catch (err) {
      setActionNotice(
        err instanceof Error ? err.message : "Failed to stop trading",
        "error",
        4000,
      );
    } finally {
      setActionInFlight(null);
    }
  }, [setActionNotice, onStrategyChange]);

  const isRunning = strategy?.running ?? false;
  const strategyName = strategy?.name ?? null;
  const params = strategy?.params ?? {};
  const paramEntries = Object.entries(params);

  return (
    <div className="rounded-3xl border border-border/18 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_98%,transparent))] px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold text-txt">
            Trading Strategy
          </span>
        </div>
        <div className="flex items-center gap-2">
          {strategyName && (
            <StatusBadge label={STRATEGY_LABELS[strategyName]} tone="muted" />
          )}
          {strategy !== null && (
            <StatusBadge
              label={isRunning ? "Running" : "Stopped"}
              tone={isRunning ? "success" : "muted"}
              withDot
            />
          )}
        </div>
      </div>

      {strategy === null && (
        <p className="text-xs text-muted">
          No strategy configured. Strategy endpoint will be available soon.
        </p>
      )}

      {strategy !== null && (
        <>
          {/* Params table */}
          {paramEntries.length > 0 && (
            <div className="rounded-xl border border-border/20 bg-card/40 overflow-hidden">
              <div className="flex items-center gap-1.5 border-b border-border/20 px-4 py-2">
                <Settings2 className="h-3 w-3 text-muted" />
                <span className="text-xs-tight font-semibold uppercase tracking-wider text-muted/70">
                  Parameters
                </span>
              </div>
              <div className="divide-y divide-border/10">
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
          )}

          {/* Controls */}
          <div className="flex items-center gap-2">
            {isRunning ? (
              <Button
                variant="outline"
                size="sm"
                className="h-9 rounded-xl px-4 text-xs font-semibold text-status-danger border-status-danger/30 hover:bg-status-danger-bg hover:text-status-danger"
                onClick={() => void handleStop()}
                disabled={actionInFlight !== null}
              >
                {actionInFlight === "stop" ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Pause className="h-3.5 w-3.5" />
                )}
                Stop Trading
              </Button>
            ) : (
              <Button
                variant="default"
                size="sm"
                className="h-9 rounded-xl bg-ok px-4 text-xs font-semibold text-white shadow-sm hover:bg-ok"
                onClick={() => void handleStart()}
                disabled={actionInFlight !== null}
              >
                {actionInFlight === "start" ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                Start Trading
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
