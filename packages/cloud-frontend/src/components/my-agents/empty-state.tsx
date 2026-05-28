/**
 * Empty state component for My Agent when no cloud agent exists.
 */
"use client";

import { BrandButton, EmptyState } from "@elizaos/ui";
import { Server } from "lucide-react";

interface EmptyStateProps {
  onCreateNew: () => void;
}

function AgentsEmptyState({ onCreateNew }: EmptyStateProps) {
  return (
    <EmptyState
      title="No cloud agent yet"
      action={
        <BrandButton
          onClick={onCreateNew}
          className="bg-primary text-primary-fg hover:bg-black hover:text-white active:bg-black/90"
        >
          <Server className="h-4 w-4" />
          Open runtime admin
        </BrandButton>
      }
    />
  );
}

export { AgentsEmptyState as EmptyState };
