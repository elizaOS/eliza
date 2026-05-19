import type * as React from "react";
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
export declare function TrajectoryCacheStats({ emptyLabel, heading, metrics, }: TrajectoryCacheStatsProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=trajectory-cache-stats.d.ts.map