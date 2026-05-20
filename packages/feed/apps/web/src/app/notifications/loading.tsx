import { PageContainer } from '@/components/shared/PageContainer';
import {
  NotificationItemSkeleton,
  Skeleton,
} from '@/components/shared/Skeleton';

export default function NotificationsLoading() {
  return (
    <PageContainer noPadding className="!overflow-visible flex w-full flex-col">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-border lg:border-r lg:border-l">
        {/* Sticky header */}
        <div className="sticky top-0 z-10 border-border border-b bg-background/95 backdrop-blur-sm">
          <div className="px-4 py-3 lg:px-6">
            <Skeleton className="h-7 w-40" />
          </div>
        </div>

        {/* Notifications list */}
        <div className="relative flex-1 overflow-y-auto">
          {Array.from({ length: 10 }).map((_, i) => (
            <NotificationItemSkeleton key={i} />
          ))}
        </div>
      </div>
    </PageContainer>
  );
}
