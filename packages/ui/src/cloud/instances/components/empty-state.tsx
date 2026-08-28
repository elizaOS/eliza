/**
 * Empty state for the agent library when no cloud agent exists yet. Uses the
 * canonical Button's default darker-orange hover.
 */
"use client";

import { Button, EmptyState } from "@elizaos/ui/cloud-ui";
import { Bot, Plus } from "lucide-react";
import { useT } from "../lib/i18n";

interface EmptyStateProps {
  onCreateNew: () => void;
}

function AgentsEmptyState({ onCreateNew }: EmptyStateProps) {
  const t = useT();
  return (
    <EmptyState
      icon={<Bot className="size-6" />}
      title={t("cloud.myAgents.noCloudAgent", {
        defaultValue: "No agents yet",
      })}
      description={t("cloud.myAgents.noCloudAgentDesc", {
        defaultValue:
          "Create your first agent to start chatting. It only takes a minute.",
      })}
      action={
        <Button variant="default" onClick={onCreateNew}>
          <Plus className="size-4" />
          {t("cloud.myAgents.createFirstAgent", {
            defaultValue: "Create your first agent",
          })}
        </Button>
      }
    />
  );
}

export { AgentsEmptyState as EmptyState };
