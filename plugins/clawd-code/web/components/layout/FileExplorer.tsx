"use client";

import { FolderOpen } from "lucide-react";

/** Placeholder — full workspace file browser is not implemented yet. */
export function FileExplorer() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-surface-500 px-4 text-center">
      <FolderOpen className="w-5 h-5" />
      <p className="text-xs">File browser not implemented yet</p>
    </div>
  );
}
