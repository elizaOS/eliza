/**
 * Containers skeleton loading component displaying placeholder table rows.
 * Shows loading state for containers table with skeleton elements.
 */
import { DashboardTableSkeleton } from "@elizaos/ui";

export function ContainersSkeleton() {
  return (
    <DashboardTableSkeleton
      columns={[
        { key: "name", label: "Name", skeletonClassName: "w-32" },
        { key: "status", label: "Status", skeletonClassName: "h-6 w-20" },
        { key: "port", label: "Port", skeletonClassName: "w-12" },
        { key: "instances", label: "Instances", skeletonClassName: "w-8" },
        { key: "deployed", label: "Deployed", skeletonClassName: "w-24" },
        {
          key: "actions",
          label: "Actions",
          cellClassName: "text-right",
          skeletonClassName: "ml-auto h-8 w-20",
        },
      ]}
    />
  );
}
