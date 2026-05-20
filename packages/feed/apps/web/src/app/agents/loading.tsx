import { Skeleton } from '@/components/shared/Skeleton';

export default function AgentsLoading() {
  return (
    <div className="flex h-[calc(100dvh-56px-var(--bottom-nav-height))] flex-col md:h-dvh">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Member sidebar skeleton */}
        <div className="hidden w-64 flex-col border-border border-r p-4 lg:flex">
          <Skeleton className="mb-4 h-8 w-32" />
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-full" />
                <Skeleton className="h-4 w-24" />
              </div>
            ))}
          </div>
        </div>
        {/* Chat area skeleton */}
        <div className="flex flex-1 flex-col">
          <div className="p-4">
            <Skeleton className="h-8 w-48" />
          </div>
          <div className="flex-1" />
        </div>
      </div>
    </div>
  );
}
