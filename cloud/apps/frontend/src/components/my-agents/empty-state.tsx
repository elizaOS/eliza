/**
 * Empty state component for my agents page when no agents exist.
 */
"use client";

import { BrandButton, EmptyState } from "@elizaos/cloud-ui";
import { MessageSquare } from "lucide-react";

interface EmptyStateProps {
  onCreateNew: () => void;
}

export function AgentsEmptyState({ onCreateNew }: EmptyStateProps) {
  return (
    <EmptyState
      title="No agents yet"
      action={
        <BrandButton
          onClick={onCreateNew}
          className="bg-[#FF5800] text-white hover:bg-[#FF5800]/90 active:bg-[#FF5800]/80"
        >
          <MessageSquare className="h-4 w-4" />
          Open Chat
        </BrandButton>
      }
    />
  );
}

// Keep backward-compatible export
export { AgentsEmptyState as EmptyState };
