"use client";

import { useSetPageHeader } from "@elizaos/ui";
import { AdminMetricsClient } from "./admin-metrics-client";
import { CloudObservabilityPanel } from "./cloud-observability-panel";

export function AdminMetricsWrapper() {
  useSetPageHeader({
    title: "Engagement Metrics",
    description: "User engagement KPIs across all platforms",
  });

  return (
    <div className="space-y-6">
      <CloudObservabilityPanel />
      <AdminMetricsClient />
    </div>
  );
}
