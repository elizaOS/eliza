import type * as React from "react";
export type TrajectoryTimelineStatus = "queued" | "running" | "success" | "failure" | "skipped" | "info";
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
export declare function TrajectoryEventTimeline({ emptyLabel, events, heading, }: TrajectoryEventTimelineProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=trajectory-event-timeline.d.ts.map