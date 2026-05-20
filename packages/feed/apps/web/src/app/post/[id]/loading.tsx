import { PageContainer } from '@/components/shared/PageContainer';
import { PostCardSkeleton, Skeleton } from '@/components/shared/Skeleton';

export default function PostDetailLoading() {
  return (
    <PageContainer
      noPadding
      className="flex min-h-dvh flex-col md:min-h-screen"
    >
      {/* Desktop */}
      <div className="hidden flex-1 lg:flex">
        {/* Main Content */}
        <div className="flex min-w-0 flex-1 flex-col border-border border-r border-l">
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[700px]">
              {/* Post Detail */}
              <PostCardSkeleton />

              {/* Comments Section */}
              <div className="space-y-4 p-4 sm:p-6">
                <Skeleton className="mb-4 h-6 w-32 max-w-full" />
                {Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={i}
                    className="flex gap-3 border-border/5 border-b pb-4"
                  >
                    <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Skeleton className="h-4 w-24 max-w-full" />
                        <Skeleton className="h-3 w-16" />
                      </div>
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-3/4 max-w-full" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Right: Widget placeholder */}
        <div className="w-80 shrink-0 border-border/5 border-l bg-background xl:w-96" />
      </div>

      {/* Mobile/Tablet */}
      <div className="flex flex-1 overflow-y-auto lg:hidden">
        <div className="w-full">
          {/* Post Detail */}
          <PostCardSkeleton />

          {/* Comments Section */}
          <div className="space-y-4 p-4">
            <Skeleton className="mb-4 h-5 w-24 max-w-full" />
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="flex gap-3 border-border/5 border-b pb-4">
                <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Skeleton className="h-4 w-20 max-w-full" />
                    <Skeleton className="h-3 w-12" />
                  </div>
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3 max-w-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
