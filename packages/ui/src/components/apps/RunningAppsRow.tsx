/**
 * Horizontal strip of currently-running app runs: each entry shows the app's
 * hero, a health-tone status dot, any attention reasons from
 * `getRunAttentionReasons`, and a stop button. Opening or stopping a run is
 * delegated to `onOpenRun`/`onStopRun`; `busyRunId`/`stoppingRunId` disable the
 * affected entry while an action is in flight.
 */

import { Square } from "lucide-react";
import { type MouseEvent, memo, useMemo } from "react";
import type { AppRunSummary, RegistryAppInfo } from "../../api";
import { Button } from "../ui/button";
import { AppHero, type AppIdentitySource } from "./app-identity";
import { getRunAttentionReasons } from "./run-attention";

interface RunningAppsRowProps {
  runs: AppRunSummary[];
  catalogApps: RegistryAppInfo[];
  busyRunId: string | null;
  onOpenRun: (run: AppRunSummary) => void;
  onStopRun?: (run: AppRunSummary) => void;
  stoppingRunId?: string | null;
}

function getHealthTone(state: AppRunSummary["health"]["state"]): {
  dot: string;
  ring: string;
} {
  if (state === "healthy") {
    return { dot: "bg-ok", ring: "" };
  }
  if (state === "degraded") {
    return { dot: "bg-warn", ring: "" };
  }
  return { dot: "bg-danger", ring: "" };
}

interface RunningAppCardProps {
  run: AppRunSummary;
  app: AppIdentitySource;
  isBusy: boolean;
  isStopping: boolean;
  onOpenRun: (run: AppRunSummary) => void;
  onStopRun?: (run: AppRunSummary) => void;
}

const RunningAppCard = memo(function RunningAppCard({
  run,
  app,
  isBusy,
  isStopping,
  onOpenRun,
  onStopRun,
}: RunningAppCardProps) {
  const attentionReasons = getRunAttentionReasons(run);
  const needsAttention = attentionReasons.length > 0;
  const tone = getHealthTone(run.health.state);

  return (
    <div
      data-testid={`running-app-card-${run.runId}`}
      className="group relative overflow-hidden rounded-sm border border-accent/35 bg-card/72 transition-all hover:border-accent/55  "
    >
      <Button
        variant="ghost"
        aria-label={`Open ${run.displayName}`}
        aria-busy={isBusy || undefined}
        className="block h-auto w-full rounded-none p-0 text-left font-normal whitespace-normal hover:bg-transparent"
        onClick={() => onOpenRun(run)}
      >
        <AppHero
          app={app}
          className="aspect-[5/4] transition-transform duration-300 group-hover:scale-[1.02]"
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end p-4 pe-12">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-white">
              {run.displayName}
            </div>
          </div>
        </div>
      </Button>

      <span
        title={needsAttention ? attentionReasons[0] : run.health.state}
        className={`pointer-events-none absolute right-4 top-4 h-2.5 w-2.5 rounded-full ${tone.dot} ${tone.ring}`}
      />

      {needsAttention ? (
        <span
          title={attentionReasons[0]}
          className="pointer-events-none absolute right-10 top-3.5 inline-flex items-center rounded-full border border-warn/40 bg-black/40 px-2 py-0.5 text-[0.56rem] font-semibold uppercase tracking-[0.2em] text-warn"
        >
          !
        </span>
      ) : null}

      {onStopRun ? (
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid={`running-app-stop-${run.runId}`}
          aria-label={`Stop ${run.displayName}`}
          disabled={isStopping}
          className="absolute bottom-3 right-3 h-8 w-8 rounded-full bg-black/70 p-0 text-white/90 transition-all hover:bg-danger/80 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          onClick={(event: MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            onStopRun(run);
          }}
        >
          {isStopping ? (
            <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
          ) : (
            <Square className="h-3.5 w-3.5" aria-hidden />
          )}
        </Button>
      ) : null}
    </div>
  );
});

export function RunningAppsRow({
  runs,
  catalogApps,
  busyRunId,
  onOpenRun,
  onStopRun,
  stoppingRunId,
}: RunningAppsRowProps) {
  const catalogAppByName = useMemo(
    () => new Map(catalogApps.map((app) => [app.name, app] as const)),
    [catalogApps],
  );

  if (runs.length === 0) return null;

  return (
    <section data-testid="running-apps-row" className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-accent">
          Running
        </h2>
        <div className="h-px flex-1 bg-border/30" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {runs.map((run) => {
          const app = catalogAppByName.get(run.appName) ?? {
            name: run.appName,
            displayName: run.displayName,
            category: "utility",
            icon: null,
          };
          return (
            <RunningAppCard
              key={run.runId}
              run={run}
              app={app}
              isBusy={busyRunId === run.runId}
              isStopping={stoppingRunId === run.runId}
              onOpenRun={onOpenRun}
              onStopRun={onStopRun}
            />
          );
        })}
      </div>
    </section>
  );
}
