import { PageContainer } from "@/components/shared/PageContainer";
import { Skeleton } from "@/components/shared/Skeleton";

export default function GameLoading() {
  return (
    <PageContainer>
      <div className="mx-auto w-full max-w-6xl space-y-6 px-4 sm:px-0">
        {/* Header */}
        <div className="space-y-2">
          <Skeleton className="h-8 w-48 max-w-full" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>

        {/* Game Controls */}
        <div className="flex flex-wrap gap-3 sm:gap-4">
          <Skeleton className="h-10 w-24 rounded-lg" />
          <Skeleton className="h-10 w-24 rounded-lg" />
          <Skeleton className="h-10 w-32 rounded-lg" />
        </div>

        {/* Game Stats */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="space-y-2 rounded-lg border border-border bg-card/50 p-4 backdrop-blur sm:p-6"
            >
              <Skeleton className="h-4 w-24 max-w-full" />
              <Skeleton className="h-6 w-32 max-w-full sm:h-8" />
            </div>
          ))}
        </div>

        {/* Game Content */}
        <div className="rounded-lg border border-border bg-card/50 p-4 backdrop-blur sm:p-6">
          <Skeleton className="h-64 w-full rounded-lg sm:h-96" />
        </div>
      </div>
    </PageContainer>
  );
}
