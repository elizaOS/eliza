"use client";

import { useSetPageHeader } from "@elizaos/cloud-ui";
import { AdminMetricsClient } from "./admin-metrics-client";

export function AdminMetricsWrapper() {
  useSetPageHeader({
    title: "Engagement Metrics",
    description: "User engagement KPIs across all platforms",
  });

  return <AdminMetricsClient />;
}
