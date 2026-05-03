/**
 * Lazy-loaded wrapper for UsageChart component.
 * Reduces initial bundle size by code-splitting Recharts dependencies (~100KB).
 */

"use client";

import { Skeleton } from "@elizaos/cloud-ui";
import dynamic from "@elizaos/cloud-ui/runtime/dynamic";
import { ComponentProps } from "react";

const UsageChartComponent = dynamic(
  () =>
    import("./usage-chart").then((mod) => ({
      default: mod.UsageChart,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    ),
  },
);

export type UsageChartProps = ComponentProps<typeof UsageChartComponent>;

export const UsageChartLazy = (props: UsageChartProps) => {
  return <UsageChartComponent {...props} />;
};
