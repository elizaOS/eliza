import type { MouseEvent } from "react";
import type { AppRunSummary, RegistryAppInfo } from "../../api";
import { AppIdentityTile } from "./app-identity";
import { getRunAttentionReasons } from "./run-attention";

interface RunningAppsRowProps {
  runs: AppRunSummary[];
  catalogApps: RegistryAppInfo[];
  busyRunId: string | null;
  onOpenRun: (run: AppRunSummary) => void;
  onStopRun?: (run: AppRunSummary) => void;
  stoppingRunId?: string | null;
}

function HealthBadge({ run }: { run: AppRunSummary }) {
  const toneClass =
    run.health.state === "healthy"
      ? "border-ok/30 bg-ok/10 text-ok"
      : run.health.state === "degraded"
        ? "border-warn/30 bg-warn/10 text-warn"
        : "border-danger/30 bg-danger/10 text-danger";

  return (
    <span
      className={`inline-flex min-h-5 items-center rounded-full border px-2 py-0.5 text-2xs font-medium uppercase tracking-[0.14em] ${toneClass}`}
    >
      {run.health.state}
    </span>
  );
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

          return (
            <div
              key={run.runId}
              data-testid={`running-app-card-${run.runId}`}
              className="group rounded-2xl border border-accent/25 bg-card/72 transition-all hover:border-accent/45 hover:bg-bg-hover/70 focus-within:ring-2 focus-within:ring-accent/35"
            >
              <button
                type="button"
                aria-label={`Open ${run.displayName}`}
                aria-busy={isBusy || undefined}
                className="flex w-full flex-col p-4 text-left focus-visible:outline-none"
                onClick={() => onOpenRun(run)}
              >
                <div className="flex items-start gap-3">
                  <AppIdentityTile app={app} active size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold text-txt">
                        {run.displayName}
                      </span>
                      <HealthBadge run={run} />
                    </div>
                    <div className="mt-1 line-clamp-1 text-xs-tight text-muted-strong">
                      {run.status}
                    </div>
                  </div>
                </div>
              </button>
              {needsAttention ? (
                <div className="px-4 pb-3">
                  <div className="flex flex-wrap gap-1.5">
                    <span className="inline-flex items-center rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 text-2xs font-medium uppercase tracking-[0.12em] text-warn">
                      Needs attention
                    </span>
                  </div>
                </div>
              ) : null}
              {onStopRun ? (
                <div className="flex justify-end px-4 pb-4">
                  <button
                    type="button"
                    data-testid={`running-app-stop-${run.runId}`}
                    aria-label={`Stop ${run.displayName}`}
                    disabled={stoppingRunId === run.runId}
                    className="inline-flex items-center rounded-full border border-danger/30 bg-danger/10 px-3 py-1 text-2xs font-semibold uppercase tracking-[0.14em] text-danger transition-all hover:border-danger/60 hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={(event: MouseEvent<HTMLButtonElement>) => {
                      event.stopPropagation();
                      onStopRun(run);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.stopPropagation();
                      }
                    }}
                  >
                    {stoppingRunId === run.runId ? "Stopping…" : "Stop"}
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
