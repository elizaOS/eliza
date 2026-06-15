import {
  type AppDetailExtensionProps,
  type AppRunSummary,
  useApp,
} from "@elizaos/ui";
import { useMemo } from "react";

type AppRunEvent = NonNullable<AppRunSummary["recentEvents"]>[number];
type AppSessionActivity = NonNullable<
  NonNullable<AppRunSummary["session"]>["activity"]
>[number];

export function ClawvilleDetailExtension({ app }: AppDetailExtensionProps) {
  const { appRuns } = useApp();
  const run = useMemo(() => selectRun(app.name, appRuns), [app.name, appRuns]);

  if (!run) {
    return (
      <section className="rounded-2xl border border-border/35 bg-card/74 p-4 text-xs text-muted-strong">
        Launch ClawVille to attach the reef dashboard.
      </section>
    );
  }

  const telemetry = asRecord(run.session?.telemetry);
  const nearest =
    readString(telemetry, "nearestBuildingLabel") ??
    readString(telemetry, "nearestBuildingId") ??
    "Reef";
  const activity = collectActivity(run).slice(0, 3);

  return (
    <section className="space-y-3" data-testid="clawville-detail-dashboard">
      <div className="rounded-2xl border border-border/40 bg-card/80 p-3">
        <div className="flex items-center gap-2">
          <StatusDot status={run.status} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-txt">
              {run.session?.goalLabel ?? `Near ${nearest}`}
            </div>
            <div className="text-2xs uppercase tracking-[0.16em] text-muted">
              {statusLabel(run.status)}
            </div>
          </div>
          <Pill tone={run.session?.canSendCommands ? "success" : "warn"}>
            {run.session?.canSendCommands ? "Relay" : "Sync"}
          </Pill>
        </div>
      </div>

      <div className="grid gap-2">
        <Metric
          label="Location"
          value={formatBuilding(nearest)}
          tone="success"
          detail={readString(telemetry, "nearestBuildingId")}
        />
        <Metric
          label="Wallet"
          value={readString(telemetry, "walletAddress") ?? "Pending"}
          tone={readString(telemetry, "walletAddress") ? "success" : "warn"}
        />
        <Metric
          label="Viewer"
          value={run.viewerAttachment ?? "attached"}
          tone={run.viewerAttachment === "detached" ? "warn" : "success"}
          detail={formatTime(run.lastHeartbeatAt ?? run.updatedAt)}
        />
      </div>

      <ActivityList items={activity} />
    </section>
  );
}

function selectRun(appName: string, appRuns: AppRunSummary[]) {
  return [...(Array.isArray(appRuns) ? appRuns : [])]
    .filter((candidate) => candidate.appName === appName)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function collectActivity(run: AppRunSummary) {
  return [
    ...(run.recentEvents ?? []).map((event: AppRunEvent) => ({
      id: event.eventId,
      label: event.kind,
      detail: event.message,
      timestamp: event.createdAt,
    })),
    ...(run.session?.activity ?? []).map((event: AppSessionActivity) => ({
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

function formatBuilding(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatTime(value: string | number | null | undefined): string {
  if (value == null) return "No heartbeat";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function statusLabel(status: string): string {
  if (status === "running" || status === "ready") return "Live";
  if (status === "degraded" || status === "failed") return "Needs attention";
  return "Starting";
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "running" || status === "ready"
      ? "bg-cyan-400"
      : status === "degraded" || status === "failed"
        ? "bg-amber-400"
        : "bg-slate-400";
  return <span className={`h-3 w-3 shrink-0 rounded-full ${color}`} />;
}

function Pill({
  tone,
  children,
}: {
  tone: "success" | "warn";
  children: string;
}) {
  const classes =
    tone === "success"
      ? "border-emerald-400/40 bg-emerald-400/12 text-emerald-200"
      : "border-amber-400/40 bg-amber-400/12 text-amber-200";
  return (
    <span
      className={`rounded-full border px-2 py-1 text-2xs font-semibold uppercase tracking-[0.14em] ${classes}`}
    >
      {children}
    </span>
  );
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
      ? "bg-cyan-400"
      : tone === "warn"
        ? "bg-amber-400"
        : "bg-slate-400";
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
        No reef events yet.
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
