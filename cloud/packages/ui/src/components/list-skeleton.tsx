import { cn } from "../lib/utils";

interface ListSkeletonProps {
  /** Number of skeleton rows */
  rows?: number;
  /** Visual variant */
  variant?: "card" | "table" | "list";
  /** Additional CSS classes */
  className?: string;
}

function ListSkeleton({ rows = 3, variant = "card", className }: ListSkeletonProps) {
  return (
    <div data-slot="list-skeleton" className={cn("space-y-4", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className={cn(
            "animate-pulse",
            variant === "card" && "flex items-center justify-between p-4 bg-white/5 rounded-lg",
            variant === "table" && "flex items-center gap-4 px-4 py-3 border-b border-white/5",
            variant === "list" && "flex items-center gap-3 p-3",
          )}
        >
          <div className="flex items-center gap-4 flex-1">
            <div className="w-12 h-12 bg-white/10 rounded-lg shrink-0" />
            <div className="space-y-2 flex-1">
              <div className="h-4 bg-white/10 rounded w-1/4" />
              <div className="h-3 bg-white/10 rounded w-1/2" />
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="h-8 w-20 bg-white/10 rounded" />
            <div className="h-8 w-8 bg-white/10 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

export type { ListSkeletonProps };
export { ListSkeleton };
