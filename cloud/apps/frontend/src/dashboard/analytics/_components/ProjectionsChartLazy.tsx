/**
 * Lazy-loaded wrapper for ProjectionsChart component.
 * Reduces initial bundle size by code-splitting Recharts dependencies.
 */

"use client";

import { dynamic, Skeleton } from "@elizaos/cloud-ui";
import { ComponentProps } from "react";

const ProjectionsChartComponent = dynamic(
  () =>
    import("./projections-chart").then((mod) => ({
      default: mod.ProjectionsChart,
    })),
  {
    ssr: false,
    loading: () => <Skeleton className="h-64 w-full" />,
  },
);

export type ProjectionsChartProps = ComponentProps<typeof ProjectionsChartComponent>;

export const ProjectionsChartLazy = (props: ProjectionsChartProps) => {
  return <ProjectionsChartComponent {...props} />;
};
