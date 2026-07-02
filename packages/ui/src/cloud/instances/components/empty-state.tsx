/**
 * Empty state for the agent library when no cloud agent exists yet. Uses
 * BrandButton's default primary hover (darker orange).
 */
"use client";

import { BrandButton, EmptyState } from "@elizaos/ui/cloud-ui";
import { Server } from "lucide-react";
import { useT } from "../lib/i18n";

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
        <BrandButton variant="primary" onClick={onCreateNew}>
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
