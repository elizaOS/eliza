/**
 * Profile Loading Component
 *
 * @description Loading skeleton for the user profile page, displaying skeleton
 * loaders for the profile header and feed sections. Responsive layout with
 * optional sidebar on large screens.
 *
 * @returns {JSX.Element} Profile loading skeleton
 */
import { PageContainer } from '@/components/shared/PageContainer';
import {
  FeedSkeleton,
  ProfileHeaderSkeleton,
} from '@/components/shared/Skeleton';

export default function ProfileLoading() {
  return (
    <PageContainer noPadding className="min-h-dvh md:min-h-screen">
      <div className="flex flex-1 overflow-hidden">
        {/* Main Content */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            {/* Profile Header */}
            <ProfileHeaderSkeleton />

            {/* Posts */}
            <div className="mt-4 border-border/5 border-t">
              <FeedSkeleton count={5} />
            </div>
          </div>
        </div>

        {/* Right: Widget placeholder - only on xl screens to match actual page */}
        <div className="hidden w-96 flex-shrink-0 flex-col bg-sidebar p-4 xl:flex" />
      </div>
    </PageContainer>
  );
}
