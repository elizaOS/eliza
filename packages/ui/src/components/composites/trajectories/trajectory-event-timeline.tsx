/**
 * Vertical timeline of trajectory events (per stage), each with a status glyph
 * (queued/running/success/failure/skipped/info), label, and timestamp. The
 * parent supplies formatted events; this renders the ordered list.
 */
import { CheckCircle, Circle, Clock3, XCircle } from "lucide-react";
import type * as React from "react";

import { Badge } from "../../ui/badge";
import { Card } from "../../ui/card";
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
    <PagePanel variant="section" className="px-5 py-4">
      <div className="mb-3 text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted">
        {heading}
      </div>
      {events.length === 0 ? (
        <Card variant="dashedEmpty">{emptyLabel}</Card>
      ) : (
        <ol className="space-y-2">
          {events.map((event) => (
            <Card
              asChild
              key={event.id}
              variant="insetPadded"
              className="grid grid-cols-[1.5rem_1fr] gap-3"
            >
              <li>
                <div className="mt-0.5 flex justify-center">
                  {statusIcon(event.status)}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-sm font-semibold text-txt">
                      {event.label}
                    </span>
                    {event.stage ? (
                      <Badge asChild variant="trajectoryStage" size="compact">
                        <span>{event.stage}</span>
                      </Badge>
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
                    <div className="mt-2 text-xs-tight text-muted">
                      {event.meta}
                    </div>
                  ) : null}
                </div>
              </li>
            </Card>
          ))}
        </ol>
      )}
    </PagePanel>
  );
}
