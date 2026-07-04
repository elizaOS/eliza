/**
 * Presentational building blocks for app detail-extension surfaces — section,
 * card, grid, badge, and empty-state components plus the shared `SurfaceTone`
 * palette. Registered detail extensions compose these so third-party app detail
 * panels render with consistent chrome without re-implementing base styling.
 */

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
      return "text-ok";
    case "accent":
      return "text-accent";
    case "warn":
      return "text-warn";
    case "danger":
      return "text-danger";
    default:
      return "text-muted-strong";
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
      className={`inline-flex min-h-6 items-center px-1.5 py-1 text-2xs font-medium ${toneClassName(tone)}`}
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
    <div className="px-1 py-1.5">
      <div className="text-xs-tight font-medium text-muted">{label}</div>
      <div className={`mt-0.5 text-xs leading-5 ${toneClassName(tone)}`}>
        {value}
      </div>
      {subtitle ? (
        <div className="mt-0.5 text-xs-tight leading-5 text-muted-strong">
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
    <section className="space-y-2 py-1">
      <div className="sr-only">{title}</div>
      {children}
    </section>
  );
}

export function SurfaceEmptyState({
  title,
  body,
}: {
  title: string;
  body?: string;
}) {
  return (
    <div className="px-1 py-2">
      <div className="text-xs-tight font-semibold text-muted">{title}</div>
      {body ? (
        <p className="mt-1 text-xs leading-5 text-muted-strong">{body}</p>
      ) : null}
    </div>
  );
}
