"use client";

import { Badge, useSetPageHeader } from "@elizaos/cloud-ui";

export function ContainersPageClient() {
  useSetPageHeader({
    title: "Containers",
    description: "Deploy and manage your containerized applications",
    actions: (
      <Badge variant="default" className="text-xs">
        NEW
      </Badge>
    ),
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border bg-card p-6">
        <h2 className="text-xl font-semibold mb-4">Container Management</h2>
        <p className="text-muted-foreground">Container deployment interface coming soon...</p>
      </div>
    </div>
  );
}
