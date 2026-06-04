import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../lib/utils";

interface ListSkeletonProps {
  /** Number of skeleton rows */
  rows?: number;
  /** Visual variant */
  variant?: "card" | "table" | "list";
  /** Additional CSS classes */
  className?: string;
}

function ListSkeleton({
  rows = 3,
  variant = "card",
  className,
}: ListSkeletonProps) {
  const rowIds = Array.from(
    { length: rows },
    (_, index) => `skeleton-row-${variant}-${index}`,
  );

  return (
    <div data-slot="list-skeleton" className={cn("space-y-4", className)}>
      {rowIds.map((rowId) => (
        <div
          key={rowId}
          className={cn(
            variant === "card" &&
              "flex items-center justify-between p-4 bg-white/5 rounded-sm",
            variant === "table" &&
              "flex items-center gap-4 px-4 py-3 border-b border-white/5",
            variant === "list" && "flex items-center gap-3 p-3",
          )}
        >
          <div className="flex items-center gap-4 flex-1">
            <Skeleton className="w-12 h-12 shrink-0" />
            <div className="space-y-2 flex-1">
              <Skeleton className="h-4 w-1/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-8" />
          </div>
        </div>
      ))}
    </div>
  );
}

export type { ListSkeletonProps };
export { ListSkeleton };
