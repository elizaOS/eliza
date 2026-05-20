import { PageContainer } from '@/components/shared/PageContainer';
import { Skeleton, StatsCardSkeleton } from '@/components/shared/Skeleton';

export default function RewardsLoading() {
  return (
    <PageContainer>
      <div className="mx-auto w-full max-w-4xl space-y-6">
        {/* Header */}
        <div className="space-y-2">
          <Skeleton className="h-8 w-48 max-w-full" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatsCardSkeleton />
          <StatsCardSkeleton />
          <StatsCardSkeleton />
        </div>

        {/* Referral Section */}
        <div className="space-y-4 rounded-lg border border-border bg-card/50 p-4 backdrop-blur sm:p-6">
          <Skeleton className="h-6 w-40 max-w-full" />
          <Skeleton className="h-4 w-full max-w-2xl" />
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-10 min-w-[200px] flex-1" />
            <Skeleton className="h-10 w-24 shrink-0" />
          </div>
        </div>

        {/* Rewards List */}
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="rounded-lg border border-border bg-card/50 p-4 backdrop-blur"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-5 w-32 max-w-full" />
                  <Skeleton className="h-4 w-48 max-w-full" />
                </div>
                <Skeleton className="h-6 w-16 shrink-0" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </PageContainer>
  );
}
