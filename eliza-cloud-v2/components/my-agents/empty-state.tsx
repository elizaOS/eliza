/**
 * Empty state component for my agents page when no agents exist.
 * Provides call-to-action button to create a new agent.
 *
 * @param props - Empty state configuration
 * @param props.onCreateNew - Callback when create button is clicked
 */

"use client";

import { BrandButton } from "@/components/brand";
import { Plus } from "lucide-react";

interface EmptyStateProps {
  onCreateNew: () => void;
}

export function EmptyState({ onCreateNew }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] gap-4">
      <h3 className="text-lg font-medium text-neutral-500">No agents yet</h3>
      <BrandButton
        onClick={() => (window.location.href = "/dashboard/build")}
        className="bg-[#FF5800] text-white hover:bg-[#FF5800]/90 active:bg-[#FF5800]/80"
      >
        <Plus className="h-4 w-4" />
        Create Agent
      </BrandButton>
    </div>
  );
}
