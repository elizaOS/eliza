import type * as React from "react";
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
export declare function TrajectoryContextDiffList({ diffs, emptyLabel, heading, }: TrajectoryContextDiffListProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=trajectory-context-diff-list.d.ts.map