/**
 * Shared placeholders + skeletons used across dashboard routes (SPA).
 */

import { Skeleton } from "../../../components/ui/skeleton";

function SkeletonBlock({ className }: { className: string }) {
  return <Skeleton className={className} />;
}

/**
 * Generic dashboard page skeleton. Matches the rough silhouette of most
 * dashboard pages (page header + a row of stat cards + a list/table) so the
 * Suspense fallback during route-chunk loads doesn't visually flash.
 */
export function DashboardLoadingState({ label }: { label?: string }) {
  return (
    <div
      className="space-y-6"
      aria-busy="true"
      aria-label={label ?? "Loading"}
      role="status"
    >
      <div className="space-y-2">
        <SkeletonBlock className="h-7 w-56" />
        <SkeletonBlock className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SkeletonBlock className="h-24 w-full" />
        <SkeletonBlock className="h-24 w-full" />
        <SkeletonBlock className="h-24 w-full" />
        <SkeletonBlock className="h-24 w-full" />
      </div>
      <div className="space-y-2">
        <SkeletonBlock className="h-12 w-full" />
        <SkeletonBlock className="h-12 w-full" />
        <SkeletonBlock className="h-12 w-full" />
      </div>
    </div>
  );
}

export function DashboardErrorState({ message }: { message: string }) {
  return (
    <div className="mx-auto max-w-prose space-y-3 p-12 text-sm text-red-300">
      <h1 className="text-lg font-semibold text-red-100">
        Something went wrong
      </h1>
      <p>{message}</p>
    </div>
  );
}
