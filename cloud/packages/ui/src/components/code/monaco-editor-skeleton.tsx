/**
 * Loading skeleton for Monaco editor.
 * Displays a placeholder while the Monaco editor bundle is being loaded.
 */

"use client";

import { Loader2 } from "lucide-react";

interface MonacoEditorSkeletonProps {
  height?: string;
}

export function MonacoEditorSkeleton({ height = "100%" }: MonacoEditorSkeletonProps) {
  return (
    <div className="flex items-center justify-center bg-black/60" style={{ height }}>
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span className="text-sm">Loading editor...</span>
      </div>
    </div>
  );
}
