import type React from "react";
import type {
  AppRunHealthState,
  AppRunSummary,
  AppRunViewerAttachment,
} from "../../../api";

export type SurfaceTone = "neutral" | "accent" | "success" | "warn" | "danger";

export interface SelectedAppRun {
  run: AppRunSummary | null;
  matchingRuns: AppRunSummary[];
}

function toTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function selectLatestRunForApp(
  appName: string,
  runs: AppRunSummary[] | null | undefined,
): SelectedAppRun {
  const matchingRuns = (Array.isArray(runs) ? runs : [])
    .filter((run) => run.appName === appName)
    .slice()
    .sort((left, right) => {
      const rightTime = Math.max(
        toTimestamp(right.updatedAt),
        toTimestamp(right.startedAt),
      );
      const leftTime = Math.max(
        toTimestamp(left.updatedAt),
        toTimestamp(left.startedAt),
      );
      return rightTime - leftTime;
    });

  return {
    run: matchingRuns[0] ?? null,
    matchingRuns,
  };
}

export function formatDetailTimestamp(
  value: string | number | null | undefined,
): string {
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "Not yet verified"
      : date.toLocaleString();
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "Not yet verified"
      : date.toLocaleString();
  }

  return "Not yet verified";
}

export function toneForHealthState(
  state: AppRunHealthState | null | undefined,
): SurfaceTone {
  if (state === "healthy") return "success";
  if (state === "degraded") return "warn";
  if (state === "offline") return "danger";
  return "neutral";
}

export function toneForViewerAttachment(
  attachment: AppRunViewerAttachment | null | undefined,
): SurfaceTone {
  if (attachment === "attached") return "success";
  if (attachment === "detached") return "warn";
  return "neutral";
}

export function toneForStatusText(
  status: string | null | undefined,
): SurfaceTone {
  if (!status) return "neutral";
  const normalized = status.toLowerCase();
  if (normalized.includes("running") || normalized.includes("ready")) {
    return "success";
  }
  if (normalized.includes("warn") || normalized.includes("waiting")) {
    return "warn";
  }
  if (normalized.includes("error") || normalized.includes("fail")) {
    return "danger";
  }
  return "neutral";
}

function toneClassName(tone: SurfaceTone): string {
  switch (tone) {
    case "success":
      return "border-ok/30 bg-ok/10 text-ok";
    case "accent":
      return "border-accent/25 bg-accent/10 text-accent";
    case "warn":
      return "border-warn/30 bg-warn/10 text-warn";
    case "danger":
      return "border-danger/30 bg-danger/10 text-danger";
    default:
      return "border-border/35 bg-bg-hover/70 text-muted-strong";
  }
}

export function SurfaceBadge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: SurfaceTone;
}) {
  return (
    <span
      className={`inline-flex min-h-6 items-center rounded-full border px-2.5 py-1 text-2xs font-medium uppercase tracking-[0.14em] ${toneClassName(tone)}`}
    >
      {children}
    </span>
  );
}

export function SurfaceCard({
  label,
  value,
  tone = "neutral",
  subtitle,
}: {
  label: string;
  value: React.ReactNode;
  tone?: SurfaceTone;
  subtitle?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border/35 bg-card/74 px-4 py-3 shadow-sm">
      <div className="text-xs-tight font-medium uppercase tracking-[0.16em] text-muted">
        {label}
      </div>
      <div className={`mt-1 text-xs leading-5 ${toneClassName(tone)}`}>
        {value}
      </div>
      {subtitle ? (
        <div className="mt-1 text-xs-tight leading-5 text-muted-strong">
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}

export function SurfaceGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-2 md:grid-cols-2">{children}</div>;
}

export function SurfaceSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-[1.4rem] border border-border/35 bg-card/74 p-4 shadow-sm">
      <div className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-muted">
        {title}
      </div>
      {children}
    </section>
  );
}

export function SurfaceEmptyState({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-[1.4rem] border border-border/35 bg-card/74 p-4 shadow-sm">
      <div className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-muted">
        {title}
      </div>
      <p className="mt-2 text-xs leading-6 text-muted-strong">{body}</p>
    </div>
  );
}
