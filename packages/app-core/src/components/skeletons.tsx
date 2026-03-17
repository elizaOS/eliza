/**
 * Loading skeleton components for better UX.
 */

export function SkeletonLine({
  width = "100%",
  className = "",
}: {
  width?: string;
  className?: string;
}) {
  return (
    <div
      className={`h-4 bg-bg-accent rounded animate-pulse ${className}`}
      style={{ width }}
    />
  );
}

export function SkeletonText({ lines = 3 }: { lines?: number }) {
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

export function SkeletonMessage({ isUser = false }: { isUser?: boolean }) {
  return (
    <div
      className={`flex items-start gap-3 ${isUser ? "justify-end" : "justify-start"} mt-4`}
    >
      {!isUser && (
        <div className="w-8 h-8 rounded-full bg-bg-accent animate-pulse shrink-0" />
      )}
      <div className={`max-w-[80%] space-y-2 ${isUser ? "items-end" : ""}`}>
        <div className="h-3 w-20 bg-bg-accent rounded animate-pulse" />
        <div className="px-4 py-3 bg-bg-accent rounded-2xl animate-pulse min-w-[200px]">
          <SkeletonText lines={2} />
        </div>
      </div>
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="p-4 border border-border bg-card rounded-lg space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-bg-accent animate-pulse" />
        <div className="space-y-2 flex-1">
          <SkeletonLine width="40%" />
          <SkeletonLine width="60%" />
        </div>
      </div>
      <SkeletonText lines={3} />
    </div>
  );
}

export function SkeletonSidebar() {
  return (
    <div className="w-64 space-y-2 p-4">
      <div className="h-8 w-32 bg-bg-accent rounded animate-pulse mb-6" />
      {Array.from({ length: 6 }, (_, idx) => idx).map((itemIndex) => (
        <div key={itemIndex} className="flex items-center gap-3 p-2">
          <div className="w-5 h-5 rounded bg-bg-accent animate-pulse" />
          <div className="h-4 bg-bg-accent rounded animate-pulse flex-1" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonChat() {
  return (
    <div className="p-4 space-y-2">
      <SkeletonMessage />
      <SkeletonMessage isUser />
      <SkeletonMessage />
    </div>
  );
}
