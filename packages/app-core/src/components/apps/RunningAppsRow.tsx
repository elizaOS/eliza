import { Square } from "lucide-react";
import type { MouseEvent } from "react";
import type { AppRunSummary, RegistryAppInfo } from "../../api";
import { AppHero } from "./app-identity";
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
    return { dot: "bg-ok", ring: "shadow-[0_0_0_3px_rgba(16,185,129,0.35)]" };
  }
  if (state === "degraded") {
    return { dot: "bg-warn", ring: "shadow-[0_0_0_3px_rgba(245,158,11,0.35)]" };
  }
  return { dot: "bg-danger", ring: "shadow-[0_0_0_3px_rgba(239,68,68,0.35)]" };
}

export function RunningAppsRow({
  runs,
  catalogApps,
  busyRunId,
  onOpenRun,
  onStopRun,
  stoppingRunId,
}: RunningAppsRowProps) {
  if (runs.length === 0) return null;

  const catalogAppByName = new Map(
    catalogApps.map((app) => [app.name, app] as const),
  );

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
          const attentionReasons = getRunAttentionReasons(run);
          const needsAttention = attentionReasons.length > 0;
          const isBusy = busyRunId === run.runId;
          const isStopping = stoppingRunId === run.runId;
          const tone = getHealthTone(run.health.state);

          return (
            <div
              key={run.runId}
              data-testid={`running-app-card-${run.runId}`}
              className="group relative overflow-hidden rounded-2xl border border-accent/35 bg-card/72 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.4)] transition-all hover:border-accent/55 focus-within:ring-2 focus-within:ring-accent/35"
            >
              <button
                type="button"
                aria-label={`Open ${run.displayName}`}
                aria-busy={isBusy || undefined}
                className="block w-full text-left focus-visible:outline-none"
                onClick={() => onOpenRun(run)}
              >
                <AppHero
                  app={app}
                  className="aspect-[5/4] transition-transform duration-300 group-hover:scale-[1.02]"
                />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end p-4 pe-12">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-white drop-shadow-[0_1px_6px_rgba(0,0,0,0.6)]">
                      {run.displayName}
                    </div>
                  </div>
                </div>
              </button>

              <span
                title={needsAttention ? attentionReasons[0] : run.health.state}
                className={`pointer-events-none absolute right-4 top-4 h-2.5 w-2.5 rounded-full ${tone.dot} ${tone.ring}`}
              />

              {needsAttention ? (
                <span
                  title={attentionReasons[0]}
                  className="pointer-events-none absolute right-10 top-3.5 inline-flex items-center rounded-full border border-warn/40 bg-black/40 px-2 py-0.5 text-[0.56rem] font-semibold uppercase tracking-[0.2em] text-warn backdrop-blur-sm"
                >
                  !
                </span>
              ) : null}

              {onStopRun ? (
                <button
                  type="button"
                  data-testid={`running-app-stop-${run.runId}`}
                  aria-label={`Stop ${run.displayName}`}
                  disabled={isStopping}
                  className="absolute bottom-3 right-3 inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white/90 backdrop-blur-sm transition-all hover:bg-danger/80 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
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
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
