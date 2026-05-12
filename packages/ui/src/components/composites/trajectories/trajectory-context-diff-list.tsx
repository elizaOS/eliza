import {
  Activity,
  type LucideIcon,
  Plus,
  RefreshCcw,
  Trash2,
} from "lucide-react";
import type * as React from "react";

import { PagePanel } from "../page-panel";

export interface TrajectoryContextDiffSummary {
  id: string;
  label: React.ReactNode;
  timestampLabel?: React.ReactNode;
  added?: React.ReactNode;
  removed?: React.ReactNode;
  changed?: React.ReactNode;
  tokenDelta?: React.ReactNode;
  description?: React.ReactNode;
}

export interface TrajectoryContextDiffListProps {
  diffs: readonly TrajectoryContextDiffSummary[];
  emptyLabel?: React.ReactNode;
  heading: React.ReactNode;
}

export function TrajectoryContextDiffList({
  diffs,
  emptyLabel = "Context diffs are not available for this trajectory",
  heading,
}: TrajectoryContextDiffListProps) {
  return (
    <PagePanel variant="section" className="px-5 py-4">
      <div className="mb-3 text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
        {heading}
      </div>
      {diffs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/50 px-4 py-6 text-sm text-muted">
          {emptyLabel}
        </div>
      ) : (
        <div className="space-y-3">
          {diffs.map((diff) => (
            <PagePanel variant="inset" key={diff.id} className="p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-txt">
                    {diff.label}
                  </div>
                  {diff.description ? (
                    <div className="mt-1 text-xs-tight text-muted">
                      {diff.description}
                    </div>
                  ) : null}
                </div>
                {diff.timestampLabel ? (
                  <div className="shrink-0 text-xs-tight text-muted">
                    {diff.timestampLabel}
                  </div>
                ) : null}
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-4">
                <DiffMetric icon={Plus} label="Added" value={diff.added} />
                <DiffMetric
                  icon={Trash2}
                  label="Removed"
                  value={diff.removed}
                />
                <DiffMetric
                  icon={RefreshCcw}
                  label="Changed"
                  value={diff.changed}
                />
                <DiffMetric
                  icon={Activity}
                  label="Token Delta"
                  value={diff.tokenDelta}
                />
              </div>
            </PagePanel>
          ))}
        </div>
      )}
    </PagePanel>
  );
}

function DiffMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: React.ReactNode;
  value: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/40 bg-bg/40 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-muted">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold text-txt">{value ?? "—"}</div>
    </div>
  );
}
