/**
 * Loading state component for image generation displaying skeleton placeholders.
 * Shows animated loading spinner and placeholder elements.
 */
"use client";

import { Loader2 } from "lucide-react";
import { Skeleton } from "../skeleton";

export function LoadingState() {
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="rounded-none border border-white/10 bg-black/40 overflow-hidden max-h-[500px]">
        <Skeleton className="w-full aspect-square" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Skeleton className="h-12 rounded-none" />
        <Skeleton className="h-12 rounded-none" />
      </div>

      <div className="flex items-center justify-center gap-2 py-3">
        <Loader2 className="h-4 w-4 animate-spin text-[#FF5800]" />
        <p className="text-sm font-medium text-white/60">Creating your image...</p>
      </div>
    </div>
  );
}
