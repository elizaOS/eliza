import { cn } from "../../lib/utils";
import { Skeleton } from "./skeleton";

/**
 * Reusable skeleton layouts built on the base {@link Skeleton} primitive.
 *
 * These replace generic spinners on first (cold) load so a view's shape is
 * visible immediately instead of an empty spinner — the page feels like it is
 * already there while data streams in. They are purely decorative placeholders
 * (aria-hidden); the surrounding region should carry the live region / status.
 */

function range(count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => i);
}

/** Vertical list of uniform rows — for feeds, lists, and record tables. */
export function ListSkeleton({
  rows = 6,
  rowClassName,
  className,
}: {
  rows?: number;
  rowClassName?: string;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col gap-2 p-1", className)}
      aria-hidden="true"
    >
      {range(rows).map((i) => (
        <Skeleton key={i} className={cn("h-12 w-full", rowClassName)} />
      ))}
    </div>
  );
}

/** Header row plus a grid of cells — for database / query result views. */
export function TableSkeleton({
  rows = 8,
  columns = 4,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col gap-1.5 p-1", className)}
      aria-hidden="true"
    >
      <Skeleton className="h-8 w-full" />
      {range(rows).map((r) => (
        <div key={r} className="flex gap-2">
          {range(columns).map((c) => (
            <Skeleton key={c} className="h-6 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Title, a few text lines, and a content block — for detail panels. */
export function DetailSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("flex flex-col gap-3 p-1", className)}
      aria-hidden="true"
    >
      <Skeleton className="h-7 w-1/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-4/6" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}
