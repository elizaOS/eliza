import { PageContainer } from '@/components/shared/PageContainer';
import { FeedSkeleton, Skeleton } from '@/components/shared/Skeleton';

export default function TrendingTagLoading() {
  return (
    <PageContainer noPadding className="flex w-full flex-col">
      <div className="relative flex min-h-dvh flex-1 md:min-h-screen">
        {/* Desktop */}
        <div className="hidden min-w-0 flex-1 flex-col border-border lg:flex lg:border-r lg:border-l">
          {/* Header */}
          <div className="sticky top-0 z-10 shrink-0 bg-background shadow-sm">
            <div className="px-6 py-4">
              <div className="flex items-center gap-4">
                <div className="h-9 w-9 rounded-full bg-muted" />
                <div className="space-y-1">
                  <Skeleton className="h-6 w-40" />
                  <Skeleton className="h-4 w-24" />
                </div>
              </div>
            </div>
          </div>

          {/* Posts */}
          <div className="flex-1 bg-background">
            <div className="w-full lg:mx-auto lg:max-w-[700px]">
              <FeedSkeleton count={8} />
            </div>
          </div>
        </div>

        {/* Right: Widget placeholder */}
        <div className="hidden w-80 shrink-0 xl:block xl:w-96" />

        {/* Mobile/Tablet */}
        <div className="flex flex-1 flex-col overflow-hidden lg:hidden">
          {/* Header */}
          <div className="sticky top-0 z-10 shrink-0 border-border border-b bg-background">
            <div className="flex items-center gap-4 px-4 py-3">
              <div className="h-9 w-9 rounded-full bg-muted" />
              <div className="space-y-1">
                <Skeleton className="h-6 w-36" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
          </div>

          {/* Posts */}
          <div className="flex-1 overflow-y-auto">
            <FeedSkeleton count={6} />
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
