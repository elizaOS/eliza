/**
 * Trajectory-viewer panel listing prompt-cache metrics (hits, tokens saved,
 * etc.) for one agent run. Presentational: the parent formats and passes the
 * metric rows; renders an empty-state when none were captured.
 */
import type * as React from "react";

import { Card } from "../../ui/card";
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
    <PagePanel as="section" variant="section" className="px-5 py-4">
      <div className="mb-3 text-sm font-semibold text-[color:var(--settings-foreground)]">
        {heading}
      </div>
      {metrics.length === 0 ? (
        <Card variant="dashedEmpty">{emptyLabel}</Card>
      ) : (
        <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map((metric) => (
            <PagePanel.SummaryCard
              compact
              className="px-4 py-3"
              key={
                metric.id ?? `${String(metric.label)}-${String(metric.value)}`
              }
            >
              <dt className="text-xs text-[color:var(--settings-muted)]">
                {metric.label}
              </dt>
              <dd className="mt-1 text-sm font-semibold text-[color:var(--settings-foreground)]">
                {metric.value}
              </dd>
              {metric.meta ? (
                <dd className="mt-1 text-xs text-[color:var(--settings-muted)]">
                  {metric.meta}
                </dd>
              ) : null}
            </PagePanel.SummaryCard>
          ))}
        </dl>
      )}
    </PagePanel>
  );
}
