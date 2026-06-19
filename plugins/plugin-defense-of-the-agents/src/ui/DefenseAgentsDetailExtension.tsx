import {
  type AppDetailExtensionProps,
  type AppRunSummary,
  SurfaceBadge,
  SurfaceEmptyState,
  selectLatestRunForApp,
  toneForStatusText,
  useApp,
} from "@elizaos/app-core/ui-compat";
import { useMemo } from "react";

export function DefenseAgentsDetailExtension({ app }: AppDetailExtensionProps) {
  const { appRuns } = useApp();
  const { run, matchingRuns } = useMemo(
    () => selectLatestRunForApp(app.name, appRuns),
    [app.name, appRuns],
  );

  if (!run) {
    return (
      <SurfaceEmptyState
        title="Defense"
        body="Launch the match to deploy a hero and stream lane telemetry."
      />
    );
  }

  const telemetry = asRecord(run.session?.telemetry);
  const heroClass = readString(telemetry, "heroClass") ?? "mage";
  const lane = readString(telemetry, "heroLane") ?? "mid";
  const level = readNumber(telemetry, "heroLevel");
  const hp = readNumber(telemetry, "heroHp");
  const maxHp = readNumber(telemetry, "heroMaxHp");
  const autoPlay = telemetry?.autoPlay === true;
  const activity = collectActivity(run, telemetry).slice(0, 3);

  return (
    <section className="space-y-3" data-testid="defense-detail-dashboard">
      <div className="rounded-2xl border border-border/40 bg-card/80 p-3">
        <div className="flex items-center gap-2">
          <StatusDot status={run.status} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-txt">
              {run.session?.goalLabel ?? run.summary ?? "Lane control"}
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
          label="Hero"
          value={`${formatLabel(heroClass)}${level == null ? "" : ` Lv${level}`}`}
          tone={
            hp != null && maxHp != null && hp / maxHp < 0.35
              ? "warn"
              : "success"
          }
          detail={hp == null ? undefined : `${hp}/${maxHp ?? "?"} hp`}
        />
        <Metric
          label="Lane"
          value={formatLabel(lane)}
          tone="neutral"
          detail={readString(telemetry, "gameId")}
        />
        <Metric
          label="Mode"
          value={autoPlay ? "Autoplay" : "Manual"}
          tone={autoPlay ? "success" : "warn"}
          detail={
            run.session?.canSendCommands ? "Relay ready" : "Relay pending"
          }
        />
        <Metric
          label="Viewer"
          value={run.viewerAttachment}
          tone={run.viewerAttachment === "detached" ? "warn" : "success"}
          detail={formatTime(run.lastHeartbeatAt ?? run.updatedAt)}
        />
      </div>

      <ActivityList items={activity} />
    </section>
  );
}

function collectActivity(
  run: AppRunSummary,
  telemetry: Record<string, unknown> | null,
) {
  const telemetryActivity = Array.isArray(telemetry?.recentActivity)
    ? telemetry.recentActivity
        .filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
        )
        .map((item, index) => ({
          id: `defense-telemetry-${String(item.ts ?? index)}`,
          label: readString(item, "action") ?? "game",
          detail: readString(item, "detail") ?? "No detail captured.",
          timestamp:
            typeof item.ts === "string" || typeof item.ts === "number"
              ? item.ts
              : null,
        }))
    : [];

  return [
    ...telemetryActivity,
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
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(
  source: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumber(
  source: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatTime(value: string | number | null | undefined): string {
  if (value == null) return "No heartbeat";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "running" || status === "ready"
      ? "bg-emerald-400"
      : status === "degraded" || status === "failed"
        ? "bg-amber-400"
        : "bg-slate-400";
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
  tone: "success" | "warn" | "neutral";
  detail?: string | null;
}) {
  const rail =
    tone === "success"
      ? "bg-emerald-400"
      : tone === "warn"
        ? "bg-amber-400"
        : "bg-violet-400";
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
        <div className="max-w-24 truncate text-right text-2xs text-muted">
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
        No match events yet.
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
              {formatTime(item.timestamp)}
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
