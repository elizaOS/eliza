import { Suspense } from 'react';
import { FeedSkeleton } from '@/components/shared/Skeleton';
import { FeedClient } from './FeedClient';

// Server component - fetches initial posts for better FCP/LCP
// The actual posts fetch happens in FeedClient for now to maintain SSE integration
// Future optimization: fetch initial posts here and stream them

/**
 * Feed page - Server component wrapper
 *
 * Performance optimizations:
 * 1. Server component for immediate shell render
 * 2. Suspense boundary for streaming
 * 3. FeedClient handles interactive elements
 * 4. Heavy components (WidgetSidebar) are lazy loaded in FeedClient
 */
export default function FeedPage() {
  return (
    <Suspense fallback={<FeedSkeleton />}>
      <FeedClient />
    </Suspense>
  );
}
