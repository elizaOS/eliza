"use client";

import { cn } from "../../lib/utils";
import { CodeDisplay } from "../code";

export interface OpenApiViewerProps {
  value: string;
  className?: string;
}

export function OpenApiViewer({ value, className }: OpenApiViewerProps) {
  return (
    <div
      className={cn(
        "w-full min-w-0 max-w-full overflow-hidden rounded-sm border border-white/10 bg-black/40",
        className,
      )}
    >
      <div className="h-full overflow-auto">
        <CodeDisplay
          code={value}
          language="json"
          className="min-h-full border-0 bg-transparent"
        />
      </div>
    </div>
  );
}
