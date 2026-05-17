import { CheckCircle, Circle, Clock3, XCircle } from "lucide-react";
import type * as React from "react";

import { PagePanel } from "../page-panel";

export type TrajectoryTimelineStatus =
  | "queued"
  | "running"
  | "success"
  | "failure"
  | "skipped"
  | "info";

export interface TrajectoryTimelineEvent {
  id: string;
  type: string;
  label: React.ReactNode;
  stage?: React.ReactNode;
  status?: TrajectoryTimelineStatus;
  timestampLabel?: React.ReactNode;
  description?: React.ReactNode;
  meta?: React.ReactNode;
}

export interface TrajectoryEventTimelineProps {
  emptyLabel?: React.ReactNode;
  events: readonly TrajectoryTimelineEvent[];
  heading: React.ReactNode;
}

function statusIcon(status: TrajectoryTimelineStatus | undefined) {
  switch (status) {
    case "running":
    case "queued":
      return <Clock3 className="h-3.5 w-3.5 text-primary" />;
    case "success":
      return <CheckCircle className="h-3.5 w-3.5 text-success" />;
    case "failure":
      return <XCircle className="h-3.5 w-3.5 text-danger" />;
    case "skipped":
      return <Circle className="h-3.5 w-3.5 text-muted/50" />;
    default:
      return <Circle className="h-3.5 w-3.5 text-muted" />;
  }
}

export function TrajectoryEventTimeline({
  emptyLabel = "No events captured",
  events,
  heading,
}: TrajectoryEventTimelineProps) {
  return (
    <PagePanel variant="section" className="px-5 py-4">
      <div className="mb-3 text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
        {heading}
      </div>
      {events.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/50 px-4 py-6 text-sm text-muted">
          {emptyLabel}
        </div>
      ) : (
        <ol className="space-y-2">
          {events.map((event) => (
            <li
              key={event.id}
              className="grid grid-cols-[1.5rem_1fr] gap-3 rounded-lg border border-border/40 bg-bg/40 px-3 py-3"
            >
              <div className="mt-0.5 flex justify-center">
                {statusIcon(event.status)}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate text-sm font-semibold text-txt">
                    {event.label}
                  </span>
                  {event.stage ? (
                    <span className="rounded border border-border/50 px-1.5 py-0.5 text-[11px] uppercase tracking-[0.12em] text-muted">
                      {event.stage}
                    </span>
                  ) : null}
                  {event.timestampLabel ? (
                    <span className="text-xs-tight text-muted">
                      {event.timestampLabel}
                    </span>
                  ) : null}
                </div>
                {event.description ? (
                  <div className="mt-1 line-clamp-2 text-xs-tight text-muted">
                    {event.description}
                  </div>
                ) : null}
                {event.meta ? (
                  <div className="mt-2 text-xs-tight text-muted/80">
                    {event.meta}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </PagePanel>
  );
}
