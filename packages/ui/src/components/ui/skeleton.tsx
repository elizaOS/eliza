import * as React from "react";

import { cn } from "../../lib/utils";

const Skeleton = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("animate-pulse rounded-md bg-secondary", className)}
    {...props}
  />
));
Skeleton.displayName = "Skeleton";

/* ── Skeleton Variants ───────────────────────────────────────────────── */

function SkeletonLine({
  width = "100%",
  className = "",
}: {
  width?: string;
  className?: string;
}) {
  return (
    <div
      className={cn("h-4 animate-pulse rounded bg-bg-accent", className)}
      style={{ width }}
    />
  );
}

function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: lines }, (_, i) => i).map((lineIndex) => (
        <SkeletonLine
          key={lineIndex}
          width={lineIndex === lines - 1 ? "60%" : "100%"}
        />
      ))}
    </div>
  );
}

function SkeletonMessage({ isUser = false }: { isUser?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 mt-4",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      {!isUser && (
        <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-bg-accent" />
      )}
      <div className={cn("max-w-[80%] space-y-2", isUser && "items-end")}>
        <div className="h-3 w-20 animate-pulse rounded bg-bg-accent" />
        <div className="min-w-[200px] animate-pulse rounded-2xl bg-bg-accent px-4 py-3">
          <SkeletonText lines={2} />
        </div>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 animate-pulse rounded-lg bg-bg-accent" />
        <div className="flex-1 space-y-2">
          <SkeletonLine width="40%" />
          <SkeletonLine width="60%" />
        </div>
      </div>
      <SkeletonText lines={3} />
    </div>
  );
}

function SkeletonSidebar() {
  return (
    <div className="w-64 space-y-2 p-4">
      <div className="mb-6 h-8 w-32 animate-pulse rounded bg-bg-accent" />
      {Array.from({ length: 6 }, (_, idx) => idx).map((i) => (
        <div key={i} className="flex items-center gap-3 p-2">
          <div className="h-5 w-5 animate-pulse rounded bg-bg-accent" />
          <div className="h-4 flex-1 animate-pulse rounded bg-bg-accent" />
        </div>
      ))}
    </div>
  );
}

function SkeletonChat() {
  return (
    <div className="space-y-2 p-4">
      <SkeletonMessage />
      <SkeletonMessage isUser />
      <SkeletonMessage />
    </div>
  );
}

export {
  Skeleton,
  SkeletonLine,
  SkeletonText,
  SkeletonMessage,
  SkeletonCard,
  SkeletonSidebar,
  SkeletonChat,
};
