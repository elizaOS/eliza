import { PageContainer } from "@/components/shared/PageContainer";
import {
  LeaderboardSkeleton,
  Skeleton,
  WidgetPanelSkeleton,
} from "@/components/shared/Skeleton";

export default function LeaderboardLoading() {
  return (
    <PageContainer noPadding className="!overflow-visible flex w-full flex-col">
      {/* Desktop (xl+): 2-column with sidebar */}
      <div className="hidden flex-1 overflow-hidden xl:flex">
        {/* Main content */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-border lg:border-r lg:border-l">
          {/* Sticky header with tab toggle */}
          <div className="sticky top-0 z-10 flex-shrink-0 bg-background shadow-sm">
            <div className="flex w-full items-center border-border border-b">
              {["Reputation", "Trading"].map((label) => (
                <div key={label} className="flex-1 py-3.5 text-center">
                  <Skeleton className="mx-auto h-4 w-24" />
                </div>
              ))}
            </div>
            <div className="flex w-full items-center border-border border-b">
              {["Per Wallet", "Team"].map((label) => (
                <div key={label} className="flex-1 py-3.5 text-center">
                  <Skeleton className="mx-auto h-4 w-20" />
                </div>
              ))}
            </div>
            <div className="px-3 py-3 sm:px-4 lg:px-6">
              <Skeleton className="h-4 w-64" />
            </div>
          </div>

          {/* Leaderboard list */}
          <div className="flex-1 overflow-y-auto">
            <LeaderboardSkeleton count={15} />
          </div>
        </div>

        {/* Sidebar */}
        <div className="hidden w-96 flex-shrink-0 flex-col xl:flex">
          <div className="flex flex-col gap-6 px-4 py-6">
            <WidgetPanelSkeleton />
            <WidgetPanelSkeleton />
          </div>
        </div>
      </div>

      {/* Mobile/Tablet (<xl): single column */}
      <div className="flex flex-1 flex-col overflow-hidden xl:hidden">
        {/* Sticky header with tab toggle */}
        <div className="sticky top-0 z-10 flex-shrink-0 bg-background shadow-sm">
          <div className="flex w-full items-center border-border border-b">
            {["Reputation", "Trading"].map((label) => (
              <div key={label} className="flex-1 py-3.5 text-center">
                <Skeleton className="mx-auto h-4 w-24" />
              </div>
            ))}
          </div>
          <div className="flex w-full items-center border-border border-b">
            {["Per Wallet", "Team"].map((label) => (
              <div key={label} className="flex-1 py-3.5 text-center">
                <Skeleton className="mx-auto h-4 w-20" />
              </div>
            ))}
          </div>
          <div className="px-3 py-2 sm:px-4">
            <Skeleton className="h-3 w-48 sm:h-4 sm:w-64" />
          </div>
        </div>

        {/* Leaderboard list */}
        <div className="flex-1 overflow-y-auto">
          <LeaderboardSkeleton count={10} />
        </div>
      </div>
    </PageContainer>
  );
}
