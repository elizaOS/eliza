/**
 * Empty state component for My Agent when no cloud agent exists.
 */
"use client";

import { BrandButton, EmptyState } from "@elizaos/ui";
import { Server } from "lucide-react";
import { useT } from "@/providers/I18nProvider";

interface EmptyStateProps {
  onCreateNew: () => void;
}

function AgentsEmptyState({ onCreateNew }: EmptyStateProps) {
  const t = useT();
  return (
    <EmptyState
      title={t("cloud.myAgents.noCloudAgent", {
        defaultValue: "No cloud agent yet",
      })}
      action={
        <BrandButton
          onClick={onCreateNew}
          className="bg-primary text-primary-fg hover:bg-black hover:text-white active:bg-black/90"
        >
          <Server className="h-4 w-4" />
          {t("cloud.myAgents.openRuntimeAdmin", {
            defaultValue: "Open runtime admin",
          })}
        </BrandButton>
      }
    />
  );
}

export { AgentsEmptyState as EmptyState };
