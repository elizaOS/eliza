"use client";

/**
 * Renders an OpenAPI spec as a browsable, syntax-highlighted view.
 */
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
      <section
        // The overflow viewport must be keyboard-focusable so keyboard users
        // can pan both axes without a pointer.
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable regions require a keyboard entry point
        tabIndex={0}
        aria-label="OpenAPI specification"
        className="h-full overflow-auto"
      >
        <CodeDisplay
          code={value}
          language="json"
          className="min-h-full border-0 bg-transparent"
        />
      </section>
    </div>
  );
}
