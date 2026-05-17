import type * as React from "react";

import { PagePanel } from "../page-panel";

export interface TrajectoryCacheMetric {
  id?: string;
  label: React.ReactNode;
  value: React.ReactNode;
  meta?: React.ReactNode;
}

export interface TrajectoryCacheStatsProps {
  emptyLabel?: React.ReactNode;
  heading: React.ReactNode;
  metrics: readonly TrajectoryCacheMetric[];
}

export function TrajectoryCacheStats({
  emptyLabel = "No cache observations captured",
  heading,
  metrics,
}: TrajectoryCacheStatsProps) {
  return (
    <PagePanel variant="section" className="px-5 py-4">
      <div className="mb-3 text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
        {heading}
      </div>
      {metrics.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/50 px-4 py-6 text-sm text-muted">
          {emptyLabel}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map((metric) => (
            <PagePanel.SummaryCard
              compact
              className="px-4 py-3"
              key={
                metric.id ?? `${String(metric.label)}-${String(metric.value)}`
              }
            >
              <div className="text-xs-tight uppercase tracking-[0.14em] text-muted/70">
                {metric.label}
              </div>
              <div className="mt-2 text-sm font-semibold text-txt">
                {metric.value}
              </div>
              {metric.meta ? (
                <div className="mt-1 text-xs-tight text-muted">
                  {metric.meta}
                </div>
              ) : null}
            </PagePanel.SummaryCard>
          ))}
        </div>
      )}
    </PagePanel>
  );
}
