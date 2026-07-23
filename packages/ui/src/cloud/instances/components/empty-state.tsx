/**
 * Empty state for the agent library when no cloud agent exists yet. Uses
 * BrandButton's default primary hover (darker orange).
 */
"use client";

import { BrandButton, EmptyState } from "@elizaos/ui/cloud-ui";
import { Bot, Plus } from "lucide-react";
import { useT } from "../lib/i18n";

interface EmptyStateProps {
  onCreateNew: () => void;
}

function AgentsEmptyState({ onCreateNew }: EmptyStateProps) {
  const t = useT();
  return (
    <EmptyState
      icon={<Bot className="h-6 w-6" />}
      title={t("cloud.myAgents.noCloudAgent", {
        defaultValue: "No agents yet",
      })}
      description={t("cloud.myAgents.noCloudAgentDesc", {
        defaultValue:
          "Create your first agent to start chatting. It only takes a minute.",
      })}
      action={
        <BrandButton variant="primary" onClick={onCreateNew}>
          <Plus className="h-4 w-4" />
          {t("cloud.myAgents.createFirstAgent", {
            defaultValue: "Create your first agent",
          })}
        </BrandButton>
      }
    />
  );
}

export { AgentsEmptyState as EmptyState };
