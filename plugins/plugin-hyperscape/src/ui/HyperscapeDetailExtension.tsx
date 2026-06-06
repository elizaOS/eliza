import {
  type AppDetailExtensionProps,
  type AppRunSummary,
  formatDetailTimestamp,
  SurfaceBadge,
  SurfaceEmptyState,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
  useApp,
} from "@elizaos/app-core/ui-compat";
import { useMemo } from "react";

export function HyperscapeDetailExtension({ app }: AppDetailExtensionProps) {
  const { appRuns } = useApp();
  const { run, matchingRuns } = useMemo(
    () => selectLatestRunForApp(app.name, appRuns),
    [app.name, appRuns],
  );

  if (!run) {
    return (
      <SurfaceEmptyState
        title="Hyperscape"
        body="Launch the app to attach the viewer and start telemetry."
      />
    );
  }

  const session = run.session ?? null;
  const activity = collectActivity(run).slice(0, 3);

  return (
    <section className="space-y-3" data-testid="hyperscape-detail-dashboard">
      <div className="rounded-2xl border border-border/40 bg-card/80 p-3">
        <div className="flex items-center gap-2">
          <StatusDot state={run.health.state} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-txt">
              {session?.goalLabel ?? run.summary ?? "Host ready"}
            </div>
            <div className="text-2xs uppercase tracking-[0.16em] text-muted">
              {matchingRuns.length} run{matchingRuns.length === 1 ? "" : "s"}
            </div>
          </div>
          <SurfaceBadge tone={toneForStatusText(run.status)}>
            {run.status}
          </SurfaceBadge>
        </div>
      </div>

      <div className="grid gap-2">
        <Metric
          label="Viewer"
          value={run.viewerAttachment}
          tone={toneForViewerAttachment(run.viewerAttachment)}
          detail={formatDetailTimestamp(run.lastHeartbeatAt ?? run.updatedAt)}
        />
        <Metric
          label="Follow"
          value={
            session?.followEntity ??
            run.viewer?.authMessage?.followEntity ??
            "Pending"
          }
          tone={session?.followEntity ? "success" : "warn"}
          detail={session?.characterId}
        />
        <Metric
          label="Relay"
          value={session?.canSendCommands ? "Ready" : "Waiting"}
          tone={session?.canSendCommands ? "success" : "warn"}
          detail={session?.sessionId}
        />
        <Metric
          label="Health"
          value={run.health.state}
          tone={toneForHealthState(run.health.state)}
          detail={run.health.message ?? run.healthDetails?.message}
        />
      </div>

      <ActivityList items={activity} />
    </section>
  );
}

function collectActivity(run: AppRunSummary) {
  const items = [
    ...(run.recentEvents ?? []).map((event) => ({
      id: event.eventId,
      label: event.kind,
      detail: event.message,
      timestamp: event.createdAt,
    })),
    ...(run.session?.activity ?? []).map((event) => ({
      id: event.id,
      label: event.type,
      detail: event.message,
      timestamp: event.timestamp ?? null,
    })),
  ];

  return items;
}

function StatusDot({ state }: { state: string }) {
  const color =
    state === "online"
      ? "bg-emerald-400"
      : state === "degraded"
        ? "bg-amber-400"
        : "bg-rose-400";
  return <span className={`h-3 w-3 shrink-0 rounded-full ${color}`} />;
}

function Metric({
  label,
  value,
  tone,
  detail,
}: {
  label: string;
  value: string;
  tone: "success" | "warn" | "danger" | "neutral" | string;
  detail?: string | null;
}) {
  const rail =
    tone === "success"
      ? "bg-emerald-400"
      : tone === "warn"
        ? "bg-amber-400"
        : tone === "danger"
          ? "bg-rose-400"
          : "bg-sky-400";
  return (
    <div className="grid grid-cols-[4px_1fr_auto] items-center gap-3 rounded-xl border border-border/35 bg-bg/65 px-3 py-2">
      <span className={`h-9 rounded-full ${rail}`} />
      <div className="min-w-0">
        <div className="text-2xs uppercase tracking-[0.16em] text-muted">
          {label}
        </div>
        <div className="truncate text-sm font-semibold text-txt">{value}</div>
      </div>
      {detail ? (
        <div className="max-w-28 truncate text-right text-2xs text-muted">
          {detail}
        </div>
      ) : null}
    </div>
  );
}

function ActivityList({
  items,
}: {
  items: Array<{
    id: string;
    label: string;
    detail: string;
    timestamp: string | number | null;
  }>;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-border/35 bg-bg/65 px-3 py-2 text-xs text-muted">
        No activity yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div
          key={item.id}
          className="rounded-xl border border-border/35 bg-bg/65 px-3 py-2"
        >
          <div className="flex items-center gap-2 text-2xs uppercase tracking-[0.16em] text-muted">
            <span className="truncate">{item.label}</span>
            <span className="ml-auto shrink-0">
              {formatDetailTimestamp(item.timestamp)}
            </span>
          </div>
          <div className="mt-1 line-clamp-2 text-xs leading-5 text-muted-strong">
            {item.detail}
          </div>
        </div>
      ))}
    </div>
  );
}
