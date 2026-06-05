import type React from "react";
import type { AppRunSummary } from "../../../api";

export type SurfaceTone = "neutral" | "accent" | "success" | "warn" | "danger";

export interface SelectedAppRun {
  run: AppRunSummary | null;
  matchingRuns: AppRunSummary[];
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
    <div className="rounded-sm border border-border/35 bg-card/74 px-4 py-3 ">
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
    <section className="space-y-3 rounded-sm border border-border/35 bg-card/74 p-4 ">
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
    <div className="rounded-sm border border-border/35 bg-card/74 p-4 ">
      <div className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-muted">
        {title}
      </div>
      <p className="mt-2 text-xs leading-6 text-muted-strong">{body}</p>
    </div>
  );
}
