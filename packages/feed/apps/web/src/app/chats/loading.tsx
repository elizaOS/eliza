import { ChatListSkeleton, Skeleton } from "@/components/shared/Skeleton";

export default function ChatsLoading() {
  return (
    <div className="flex h-[calc(100dvh-56px-var(--bottom-nav-height))] flex-col overflow-hidden md:h-dvh">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left column: Chat list */}
        <div className="flex w-full flex-col border-border bg-background xl:w-80 xl:border-r">
          {/* Header */}
          <div className="px-4 py-3">
            <div className="mb-4 flex items-center justify-between">
              <Skeleton className="h-7 w-32" />
              <Skeleton className="h-8 w-8 rounded" />
            </div>
            {/* Filter tabs */}
            <div className="mb-4 flex items-center border-border border-b">
              {["All", "DMs", "Groups"].map((label) => (
                <div
                  key={label}
                  className="min-h-[44px] flex-1 py-3 text-center"
                >
                  <Skeleton className="mx-auto h-4 w-12" />
                </div>
              ))}
            </div>
          </div>

          {/* Search bar */}
          <div className="relative mb-2 px-4">
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>

          {/* Chat list */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ChatListSkeleton count={10} />
          </div>
        </div>

        {/* Right column: Empty state */}
        <div className="hidden min-h-0 min-w-0 flex-1 bg-background xl:block">
          <div className="flex h-full items-center justify-center p-8">
            <div className="w-full max-w-md space-y-3 px-4 text-center">
              <Skeleton className="mx-auto h-16 w-16 rounded-full" />
              <Skeleton className="mx-auto h-6 w-48 max-w-full" />
              <Skeleton className="mx-auto h-4 w-64 max-w-full" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
