/**
 * Empty state for image generator using the shared EmptyState component.
 */
"use client";

import { Image as ImageIcon } from "lucide-react";
import { EmptyState } from "../empty-state";

export function ImageEmptyState() {
  return (
    <EmptyState
      variant="dashed"
      icon={<ImageIcon className="h-6 w-6 text-[#FF5800]" />}
      title="Enter a prompt to generate"
    />
  );
}

// Backward-compatible export
export { ImageEmptyState as EmptyState };
