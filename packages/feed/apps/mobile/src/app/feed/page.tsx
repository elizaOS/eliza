'use client';

import { FeedClient } from '@web/app/feed/FeedClient';
import { Suspense } from 'react';
import { FeedSkeleton } from '@/components/shared/Skeleton';

export default function MobileFeedPage() {
  return (
    <Suspense fallback={<FeedSkeleton />}>
      <FeedClient />
    </Suspense>
  );
}
