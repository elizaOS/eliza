/**
 * Vertical timeline of trajectory events (per stage), each with a status glyph
 * (queued/running/success/failure/skipped/info), label, and timestamp. The
 * parent supplies formatted events; this renders the ordered list.
 */
import { CheckCircle, Circle, Clock3, XCircle } from "lucide-react";
import type * as React from "react";

import { Badge } from "../../ui/badge";
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
      return <Clock3 className="size-3.5 text-primary" />;
    case "success":
      return <CheckCircle className="size-3.5 text-success" />;
    case "failure":
      return <XCircle className="size-3.5 text-danger" />;
    case "skipped":
      return <Circle className="size-3.5 text-muted/50" />;
    default:
      return <Circle className="size-3.5 text-muted" />;
  }
}

export function TrajectoryEventTimeline({
  emptyLabel = "No events captured",
  events,
  heading,
}: TrajectoryEventTimelineProps) {
  return (
    <section>
      <div className="mb-3 text-sm font-semibold text-[color:var(--settings-foreground)]">
        {heading}
      </div>
      {events.length === 0 ? (
        <div className="border-y border-dashed border-[color:var(--settings-hairline)] py-6 text-center text-sm text-[color:var(--settings-muted)]">
          {emptyLabel}
        </div>
      ) : (
        <ol className="divide-y divide-[color:var(--settings-hairline)] border-y border-[color:var(--settings-hairline)]">
          {events.map((event) => (
            <li
              key={event.id}
              className="grid min-h-14 grid-cols-[1.25rem_minmax(0,1fr)] gap-3 py-3"
            >
              <div className="mt-0.5 flex justify-center">
                {statusIcon(event.status)}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate text-sm font-medium text-[color:var(--settings-foreground)]">
                    {event.label}
                  </span>
                  {event.stage ? (
                    <Badge asChild variant="trajectoryStage" size="compact">
                      <span>{event.stage}</span>
                    </Badge>
                  ) : null}
                  {event.timestampLabel ? (
                    <span className="ml-auto text-xs text-[color:var(--settings-muted)]">
                      {event.timestampLabel}
                    </span>
                  ) : null}
                </div>
                {event.description ? (
                  <div className="mt-1 line-clamp-2 text-xs leading-5 text-[color:var(--settings-muted)]">
                    {event.description}
                  </div>
                ) : null}
                {event.meta ? (
                  <div className="mt-1 text-xs text-[color:var(--settings-muted)]">
                    {event.meta}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
